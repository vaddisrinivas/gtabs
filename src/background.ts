import type {
  Color,
  GroupSuggestion,
  MessageType,
  MergeSplitResult,
  TabInfo,
  UndoSnapshot,
  Workspace,
  WorkspaceTab,
  CorrectionEntry,
  RejectionEntry,
} from './types';
import { MODEL_PRICING } from './types';
import {
  addCost,
  addCorrections,
  addHistory,
  addRejections,
  exportAll,
  getAffinity,
  getCorrections,
  getCosts,
  getDomainRules,
  getHistory,
  getRejections,
  getSettings,
  getStats,
  getUndoSnapshot,
  getWeightedAffinity,
  importAll,
  incrementStats,
  formatWeightedAffinityHints,
  saveSuggestions,
  saveUndoSnapshot,
  summarizeCorrections,
  summarizeCoOccurrence,
  summarizeHistory,
  summarizeRejections,
  updateAffinity,
  updateCoOccurrence,
  updateWeightedAffinity,
} from './storage';
import { suggest, findDuplicates, inferTargetGroup, matchTabsToExistingGroups, truncateTitle } from './grouper';
import type { ExtraHints } from './grouper';
import { completeWithUsage, fetchOllamaModels, isChromeAIAvailable, testConnection } from './llm';

const ALARM_NAME = 'gtabs-check';
const REORG_ALARM_NAME = 'gtabs-reorg';

// In-memory state (session-only, not persisted)
const openerMap = new Map<number, number>();
const tabActivationTimes = new Map<number, number>();

const IMPORTANT_APP_PATTERNS = [
  'mail.google.com',
  'calendar.google.com',
  'docs.google.com',
  'drive.google.com',
  'notion.so',
  'notion.site',
  'figma.com',
  'linear.app',
  'atlassian.net',
  'jira.',
  'slack.com',
  'discord.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'airtable.com',
  'spotify.com',
] as const;

let autoCheckInFlight = false;

export function isTabUrlAllowed(url?: string | null): url is string {
  return Boolean(url) && !/^(chrome|edge|about|chrome-extension):\/\//.test(url!);
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isImportantAppUrl(url: string): boolean {
  const hostname = hostnameFromUrl(url);
  return IMPORTANT_APP_PATTERNS.some(pattern => hostname === pattern || hostname.endsWith(`.${pattern}`) || hostname.includes(pattern));
}

export function isGroupedTab(tab: { groupId?: number | undefined }): tab is { groupId: number } {
  return tab.groupId !== undefined && tab.groupId !== -1;
}

function toWorkspaceTab(
  tab: chrome.tabs.Tab,
  groupsById: Map<number, chrome.tabGroups.TabGroup>,
): WorkspaceTab | null {
  if (!tab.title || !isTabUrlAllowed(tab.url)) return null;
  const group = isGroupedTab(tab) ? groupsById.get(tab.groupId) : null;
  return {
    url: tab.url,
    title: tab.title,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    groupName: group?.title || undefined,
    groupColor: (group?.color as Color | undefined) || undefined,
  };
}

async function getCurrentWindowId(): Promise<number> {
  const current = await chrome.windows.getCurrent();
  if (current.id === undefined) throw new Error('Could not determine current window');
  return current.id;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;
}

async function recordModelUsage(inputTokens: number, outputTokens: number): Promise<void> {
  if (inputTokens <= 0 && outputTokens <= 0) return;
  const settings = await getSettings();
  const cost = calculateCost(settings.model, inputTokens, outputTokens);
  await addCost(settings.provider, inputTokens, outputTokens, cost);
}

export async function getTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.id !== undefined && isTabUrlAllowed(t.url))
    .map(t => ({ id: t.id!, title: t.title || '', url: t.url! }));
}

export async function snapshotCurrentState(): Promise<UndoSnapshot> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groups: { tabId: number; groupId: number }[] = [];
  const ungrouped: number[] = [];

  for (const t of tabs) {
    if (t.id === undefined) continue;
    if (isGroupedTab(t)) groups.push({ tabId: t.id, groupId: t.groupId });
    else ungrouped.push(t.id);
  }

  return { timestamp: Date.now(), groups, ungrouped };
}

export async function restoreSnapshot(snapshot: UndoSnapshot): Promise<void> {
  if (snapshot.ungrouped.length > 0) {
    try {
      await chrome.tabs.ungroup(snapshot.ungrouped as [number, ...number[]]);
    } catch (err) {
      console.error(err);
    }
  }

  const byGroup = new Map<number, number[]>();
  for (const { tabId, groupId } of snapshot.groups) {
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId)!.push(tabId);
  }

  for (const [, tabIds] of byGroup) {
    try {
      await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
    } catch (err) {
      console.error(err);
    }
  }
}

export async function organize(ungroupedOnly = false): Promise<{ suggestions?: GroupSuggestion[]; error?: string }> {
  try {
    const [settings, affinity, domainRules, history, weightedAffinity, corrections, rejections] = await Promise.all([
      getSettings(),
      getAffinity(),
      getDomainRules(),
      getHistory(),
      getWeightedAffinity(),
      getCorrections(),
      getRejections(),
    ]);

    let tabs = await getTabs();
    let existingGroupNames: string[] = [];

    if (ungroupedOnly || settings.mergeMode) {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const groupedIds = new Set(allTabs.filter(isGroupedTab).map(t => t.id).filter((id): id is number => id !== undefined));
      tabs = tabs.filter(t => !groupedIds.has(t.id));

      // Collect existing group names for smart merge
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        existingGroupNames = groups.map(g => g.title || '').filter(Boolean);
      } catch { /* ignore */ }
    }

    if (tabs.length < 2) return { error: 'Need at least 2 tabs to organize' };

    // Build extra hints from learning data
    const extraHints: ExtraHints = {};
    extraHints.affinityHint = formatWeightedAffinityHints(weightedAffinity);

    if (settings.enableCorrectionTracking) {
      extraHints.corrections = await summarizeCorrections(corrections);
    }
    if (settings.enableRejectionMemory) {
      extraHints.rejections = await summarizeRejections(rejections);
    }
    if (settings.enablePatternMining) {
      await updateCoOccurrence(history);
      extraHints.coOccurrence = await summarizeCoOccurrence();
    }

    // Build opener hints
    const openerLines: string[] = [];
    for (const tab of tabs) {
      const openerId = openerMap.get(tab.id);
      if (openerId !== undefined) {
        const openerTab = tabs.find(t => t.id === openerId);
        if (openerTab) {
          openerLines.push(`  Tab ${tab.id} was opened from Tab ${openerId} (likely related)`);
        }
      }
    }
    if (openerLines.length > 0) {
      if (openerLines.length > 15) openerLines.length = 15;
      extraHints.openers = `\nTab relationships (opened from same parent):\n${openerLines.join('\n')}\n`;
    }

    // Smart merge: pre-assign tabs matching existing group names by title
    let preMatched: GroupSuggestion[] = [];
    let tabsForLLM = tabs;
    if (existingGroupNames.length > 0) {
      const { matched, remaining } = matchTabsToExistingGroups(tabs, existingGroupNames);
      preMatched = Array.from(matched.entries()).map(([name, matchedTabs]) => ({
        name,
        color: 'grey' as const,
        tabs: matchedTabs,
      }));
      tabsForLLM = remaining;
    }

    if (tabsForLLM.length === 0 && preMatched.length > 0) {
      const suggestions = preMatched;
      await saveSuggestions(suggestions);
      await chrome.action.setBadgeText({ text: String(suggestions.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });
      return { suggestions };
    }

    const historyHint = summarizeHistory(history);
    const result = tabsForLLM.length >= 2
      ? await suggest(tabsForLLM, settings, affinity, domainRules, historyHint, extraHints)
      : { suggestions: tabsForLLM.map(t => ({ name: 'Other', color: 'grey' as const, tabs: [t] })), inputTokens: 0, outputTokens: 0 };

    const allSuggestions = [...preMatched, ...result.suggestions];

    await recordModelUsage(result.inputTokens, result.outputTokens);
    await saveSuggestions(allSuggestions);
    await chrome.action.setBadgeText({ text: String(allSuggestions.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });

    return { suggestions: allSuggestions };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export async function applyGroups(suggestions: GroupSuggestion[]): Promise<void> {
  const snapshot = await snapshotCurrentState();
  await saveUndoSnapshot(snapshot);

  const settings = await getSettings();
  const pinnedSet = new Set(settings.pinnedGroups);

  // If pinned groups exist, exclude their tabs from ungrouping
  let pinnedTabIds = new Set<number>();
  if (pinnedSet.size > 0) {
    try {
      const windowId = await getCurrentWindowId();
      const existingGroups = await chrome.tabGroups.query({ windowId });
      for (const g of existingGroups) {
        if (g.title && pinnedSet.has(g.title)) {
          const groupTabs = await chrome.tabs.query({ groupId: g.id });
          for (const t of groupTabs) {
            if (t.id !== undefined) pinnedTabIds.add(t.id);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Filter out suggestions targeting pinned groups and tabs in pinned groups
  const filteredSuggestions = suggestions.filter(g => !pinnedSet.has(g.name));
  const allTabIds = filteredSuggestions
    .flatMap(g => g.tabs.map(t => t.id))
    .filter(id => !pinnedTabIds.has(id));

  try {
    if (allTabIds.length > 0) {
      await chrome.tabs.ungroup(allTabIds as [number, ...number[]]);
    }
  } catch (err) {
    console.error(err);
  }

  for (const group of filteredSuggestions) {
    const tabIds = group.tabs.map(t => t.id).filter(id => !pinnedTabIds.has(id));
    if (tabIds.length === 0) continue;
    const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] }) as number;
    await chrome.tabGroups.update(groupId, { title: group.name, color: group.color, collapsed: false });
  }

  await updateAffinity(filteredSuggestions);
  await addHistory(filteredSuggestions);
  await incrementStats(filteredSuggestions.reduce((sum, g) => sum + g.tabs.length, 0));
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });
}

export async function undoLastGrouping(): Promise<{ error?: string }> {
  const snapshot = await getUndoSnapshot();
  if (!snapshot) return { error: 'No undo history available' };

  try {
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    const groupedIds = currentTabs.filter(isGroupedTab).map(t => t.id).filter((id): id is number => id !== undefined);
    if (groupedIds.length) {
      try {
        await chrome.tabs.ungroup(groupedIds as [number, ...number[]]);
      } catch {
        // ignored
      }
    }

    await restoreSnapshot(snapshot);
    await saveUndoSnapshot(null);


    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Undo failed' };
  }
}

export async function findDuplicateTabs(): Promise<TabInfo[][]> {
  return findDuplicates(await getTabs());
}

export async function consolidateWindows(): Promise<number> {
  const currentWindowId = await getCurrentWindowId();
  const windows = await chrome.windows.getAll({ populate: true });
  let moved = 0;

  for (const win of windows) {
    if (win.id === undefined || win.id === currentWindowId) continue;
    const tabIds = (win.tabs || [])
      .filter(tab => tab.id !== undefined && isTabUrlAllowed(tab.url))
      .map(tab => tab.id!);

    if (tabIds.length === 0) continue;
    await chrome.tabs.move(tabIds, { windowId: currentWindowId, index: -1 });
    moved += tabIds.length;
  }

  await autoPinImportantApps(currentWindowId);
  return moved;
}



export async function purgeStaleTabs(): Promise<number> {
  const settings = await getSettings();
  const thresholdMs = settings.staleTabThresholdHours * 60 * 60 * 1000;
  const now = Date.now();
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const toRemove = tabs
    .filter(tab =>
      tab.id !== undefined &&
      isTabUrlAllowed(tab.url) &&
      !tab.active &&
      !tab.pinned &&
      Boolean(tab.lastAccessed) &&
      (now - (tab.lastAccessed || now)) > thresholdMs,
    )
    .map(tab => tab.id!);

  if (toRemove.length) {
    await chrome.tabs.remove(toRemove);
  }

  return toRemove.length;
}



export async function focusCurrentGroup(): Promise<number> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.windowId === undefined) throw new Error('No active tab');
  if (!isGroupedTab(activeTab)) throw new Error('Active tab must be grouped to focus');

  const groups = await chrome.tabGroups.query({ windowId: activeTab.windowId });
  for (const group of groups) {
    await chrome.tabGroups.update(group.id, { collapsed: group.id !== activeTab.groupId });
  }

  return groups.length;
}



export async function sortCurrentGroupsByDomain(): Promise<number> {
  const tabs = (await chrome.tabs.query({ currentWindow: true }))
    .filter(tab => tab.id !== undefined && isTabUrlAllowed(tab.url));
  const buckets = new Map<string, chrome.tabs.Tab[]>();

  for (const tab of tabs) {
    const key = isGroupedTab(tab) ? `group:${tab.groupId}` : 'ungrouped';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(tab);
  }

  const orderedBuckets = Array.from(buckets.values())
    .map(bucket => bucket.sort((a, b) => (a.index || 0) - (b.index || 0)))
    .sort((a, b) => (a[0]?.index || 0) - (b[0]?.index || 0));

  for (const bucket of orderedBuckets) {
    const startIndex = bucket[0]?.index || 0;
    const sorted = [...bucket].sort((a, b) => {
      const hostDiff = hostnameFromUrl(a.url!).localeCompare(hostnameFromUrl(b.url!));
      if (hostDiff !== 0) return hostDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    for (let i = 0; i < sorted.length; i++) {
      await chrome.tabs.move(sorted[i].id!, { index: startIndex + i });
    }
  }

  await autoPinImportantApps();
  return orderedBuckets.length;
}

export async function deleteAllTabGroups(): Promise<number> {
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupedTabs = tabs
    .filter(tab => tab.id !== undefined && isGroupedTab(tab));

  if (!groupedTabs.length) return 0;

  const tabIds = groupedTabs.map(tab => tab.id!);
  const uniqueGroups = new Set(groupedTabs.map(tab => tab.groupId));
  await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
  return uniqueGroups.size;
}

export async function autoPinImportantApps(windowId?: number): Promise<number> {
  const settings = await getSettings();
  if (!settings.autoPinApps) return 0;

  const tabs = await chrome.tabs.query(windowId ? { windowId } : { currentWindow: true });
  const importantTabs = tabs
    .filter(tab =>
      tab.id !== undefined &&
      isTabUrlAllowed(tab.url) &&
      isImportantAppUrl(tab.url!) &&
      !isGroupedTab(tab),
    )
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  let pinnedCount = 0;
  for (let i = 0; i < importantTabs.length; i++) {
    const tab = importantTabs[i];
    if (!tab.pinned) pinnedCount++;
    await chrome.tabs.update(tab.id!, { pinned: true });
    await chrome.tabs.move(tab.id!, { index: i });
  }

  return pinnedCount;
}



// --- Group Drift Detection ---

export async function checkGroupDrift(): Promise<{ drifted: boolean; driftedGroups: string[] }> {
  const settings = await getSettings();
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const driftedGroups: string[] = [];

  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (tabs.length < 2) continue;

    const domainCounts: Record<string, number> = {};
    for (const tab of tabs) {
      if (!tab.url) continue;
      const domain = hostnameFromUrl(tab.url);
      if (domain) domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }

    const maxCount = Math.max(...Object.values(domainCounts), 0);
    const coherence = tabs.length > 0 ? (maxCount / tabs.length) * 100 : 100;

    if (coherence < settings.groupDriftThreshold) {
      driftedGroups.push(group.title || `Group ${group.id}`);
    }
  }

  return { drifted: driftedGroups.length > 0, driftedGroups };
}

// --- Merge/Split Suggestions ---

export async function getMergeSplitSuggestions(): Promise<MergeSplitResult> {
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const groupDomains: Map<string, Set<string>> = new Map();
  const groupTabCounts: Map<string, number> = new Map();

  for (const group of groups) {
    const name = group.title || `Group ${group.id}`;
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const domains = new Set<string>();
    for (const tab of tabs) {
      if (tab.url) {
        const d = hostnameFromUrl(tab.url);
        if (d) domains.add(d);
      }
    }
    groupDomains.set(name, domains);
    groupTabCounts.set(name, tabs.length);
  }

  const merges: MergeSplitResult['merges'] = [];
  const names = Array.from(groupDomains.keys());

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = groupDomains.get(names[i])!;
      const b = groupDomains.get(names[j])!;
      let intersection = 0;
      for (const d of a) if (b.has(d)) intersection++;
      const union = new Set([...a, ...b]).size;
      const overlap = union > 0 ? intersection / union : 0;
      if (overlap > 0.6) {
        merges.push({ group1: names[i], group2: names[j], overlap: Math.round(overlap * 100) });
      }
    }
  }

  const splits: MergeSplitResult['splits'] = [];
  for (const [name, domains] of groupDomains) {
    const tabCount = groupTabCounts.get(name) || 0;
    if (tabCount > 10 && domains.size > 5) {
      splits.push({ group: name, tabCount, domainCount: domains.size });
    }
  }

  return { merges, splits };
}

// --- Scheduled Re-org ---

export async function setupReorgAlarm(): Promise<void> {
  const settings = await getSettings();

  if (settings.reorgSchedule === 'off') {
    chrome.alarms.clear(REORG_ALARM_NAME);
    return;
  }

  const now = new Date();
  const targetHour = settings.reorgTime;
  const nextFire = new Date(now);
  nextFire.setHours(targetHour, 0, 0, 0);
  if (nextFire <= now) nextFire.setDate(nextFire.getDate() + 1);

  const delayInMinutes = Math.max(1, (nextFire.getTime() - now.getTime()) / 60000);
  const periodInMinutes = settings.reorgSchedule === 'daily' ? 1440 : 10080;

  chrome.alarms.create(REORG_ALARM_NAME, { delayInMinutes, periodInMinutes });
}

async function checkAutoTrigger(): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoTrigger) return;

  const tabs = await getTabs();
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const groupedCount = allTabs.filter(isGroupedTab).length;

  if (tabs.length - groupedCount >= settings.threshold) {
    const result = await organize(settings.mergeMode);
    if (result.suggestions?.length) {
      await applyGroups(result.suggestions);
    }
  }
}

chrome.runtime.onMessage.addListener((msg: MessageType, _sender, sendResponse) => {
  if (msg.type === 'organize') {
    organize().then(r => sendResponse({ type: 'status', status: r.error ? 'error' : 'done', ...r }));
    return true;
  }

  if (msg.type === 'organize-ungrouped') {
    organize(true).then(r => sendResponse({ type: 'status', status: r.error ? 'error' : 'done', ...r }));
    return true;
  }

  if (msg.type === 'apply') {
    applyGroups(msg.suggestions).then(() => sendResponse({ type: 'status', status: 'applied' }));
    return true;
  }

  if (msg.type === 'undo') {
    undoLastGrouping().then(r => sendResponse({ type: 'status', status: r.error ? 'error' : 'undone', error: r.error }));
    return true;
  }

  if (msg.type === 'find-duplicates') {
    findDuplicateTabs().then(duplicates => sendResponse({ type: 'status', status: 'done', duplicates }));
    return true;
  }



  if (msg.type === 'purge-stale') {
    purgeStaleTabs()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'focus-group') {
    focusCurrentGroup()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'sort-groups') {
    sortCurrentGroupsByDomain()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'delete-all-groups') {
    deleteAllTabGroups()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'get-stats') {
    getStats().then(stats => sendResponse({ type: 'status', status: 'done', stats }));
    return true;
  }

  if (msg.type === 'get-costs') {
    getCosts().then(costs => sendResponse({ type: 'status', status: 'done', costs }));
    return true;
  }

  if (msg.type === 'export-data') {
    exportAll().then(data => sendResponse({ type: 'status', status: 'done', data }));
    return true;
  }

  if (msg.type === 'import-data') {
    importAll(msg.data).then(() => sendResponse({ type: 'status', status: 'imported' }));
    return true;
  }

  if (msg.type === 'test-connection') {
    getSettings()
      .then(settings => testConnection(settings))
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'check-chrome-ai') {
    sendResponse({ type: 'status', status: 'done', available: isChromeAIAvailable() });
    return false;
  }

  if (msg.type === 'fetch-ollama-models') {
    getSettings()
      .then(settings => fetchOllamaModels(settings.baseUrl))
      .then(models => sendResponse({ type: 'status', status: 'done', models }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message, models: [] }));
    return true;
  }

  if (msg.type === 'record-corrections') {
    (async () => {
      await addCorrections(msg.corrections);
      // Apply correction weight (3x) to weighted affinity
      const correctedSuggestions: GroupSuggestion[] = [];
      for (const c of msg.corrections.corrections) {
        correctedSuggestions.push({
          name: c.correctedGroup,
          color: 'grey',
          tabs: [{ id: 0, title: '', url: `https://${c.domain}` }],
        });
      }
      if (correctedSuggestions.length > 0) {
        await updateWeightedAffinity(correctedSuggestions, 3);
      }
      sendResponse({ type: 'status', status: 'done' });
    })();
    return true;
  }

  if (msg.type === 'record-rejections') {
    addRejections(msg.rejections)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'check-group-drift') {
    checkGroupDrift()
      .then(result => sendResponse({ type: 'status', status: 'done', ...result }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }

  if (msg.type === 'merge-split-suggestions') {
    getMergeSplitSuggestions()
      .then(mergeSplit => sendResponse({ type: 'status', status: 'done', mergeSplit }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error.message }));
    return true;
  }
});

chrome.commands?.onCommand?.addListener((command: string) => {
  if (command === 'organize-tabs') organize();
  if (command === 'undo-grouping') undoLastGrouping();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 });
  setupReorgAlarm();
  chrome.contextMenus?.create({ id: 'gtabs-organize', title: 'Organize all tabs', contexts: ['action'] });
  chrome.contextMenus?.create({ id: 'gtabs-organize-ungrouped', title: 'Organize ungrouped tabs only', contexts: ['action'] });
  chrome.contextMenus?.create({ id: 'gtabs-undo', title: 'Undo last grouping', contexts: ['action'] });
  chrome.contextMenus?.create({ id: 'gtabs-duplicates', title: 'Find duplicate tabs', contexts: ['action'] });
});

chrome.contextMenus?.onClicked?.addListener((info) => {
  if (info.menuItemId === 'gtabs-organize') organize();
  if (info.menuItemId === 'gtabs-organize-ungrouped') organize(true);
  if (info.menuItemId === 'gtabs-undo') undoLastGrouping();
  if (info.menuItemId === 'gtabs-duplicates') findDuplicateTabs();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) checkAutoTrigger();
  if (alarm.name === REORG_ALARM_NAME) {
    getSettings().then(settings => {
      if (settings.reorgSchedule !== 'off') {
        organize(settings.mergeMode).then(result => {
          if (result.suggestions?.length) applyGroups(result.suggestions);
        });
      }
    });
  }
});

function triggerAutoCheck() {
  if (autoCheckInFlight) return;

  autoCheckInFlight = true;
  checkAutoTrigger()
    .catch(() => {
      // Keep auto-trigger best-effort and never break the event loop on runtime failures.
    })
    .finally(() => {
      autoCheckInFlight = false;
    });
}

chrome.tabs.onCreated?.addListener((tab: chrome.tabs.Tab) => {
  // Track opener relationship
  if (tab?.id !== undefined && tab?.openerTabId !== undefined) {
    openerMap.set(tab.id, tab.openerTabId);
  }
  triggerAutoCheck();
});

chrome.tabs.onRemoved?.addListener((tabId: number) => {
  // Clean up in-memory maps
  if (tabId !== undefined) {
    openerMap.delete(tabId);
    tabActivationTimes.delete(tabId);
  }
  triggerAutoCheck();
});

chrome.tabs.onActivated?.addListener((activeInfo: { tabId: number }) => {
  if (activeInfo?.tabId !== undefined) {
    tabActivationTimes.set(activeInfo.tabId, Date.now());
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.settings) {
    triggerAutoCheck();
    setupReorgAlarm();
  }
});

chrome.tabs.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || tab.windowId === undefined) return;
  if (!isTabUrlAllowed(tab.url)) return;

  triggerAutoCheck();

  if (isGroupedTab(tab)) return;

  const settings = await getSettings();
  if (!settings.silentAutoAdd) return;

  // 1. Check opener — if opener is in a group, prefer that group
  const openerId = openerMap.get(tabId);
  if (openerId !== undefined) {
    try {
      const openerTab = await chrome.tabs.get(openerId);
      if (isGroupedTab(openerTab) && openerTab.windowId === tab.windowId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: openerTab.groupId });
        return;
      }
    } catch { /* opener may have been closed */ }
  }

  // 2. Use enhanced inferTargetGroup with weighted affinity and rejections
  const [rules, affinity, weightedAffinity, rejections] = await Promise.all([
    getDomainRules(), getAffinity(), getWeightedAffinity(), getRejections(),
  ]);
  const inferred = inferTargetGroup(tab.url, rules, affinity, weightedAffinity, rejections);
  if (!inferred) return;

  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: inferred.name });
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    } else {
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] }) as number;
      await chrome.tabGroups.update(newGroupId, {
        title: inferred.name,
        color: inferred.color || 'grey',
        collapsed: false,
      });
    }
  } catch {
    // Ignored if grouping fails while the window is changing.
  }
});
