import type {
  Settings,
  GroupSuggestion,
  AffinityMap,
  DomainRule,
  UndoSnapshot,
  Stats,
  ExportData,
  CostTotals,
  HistoryEntry,
  Workspace,
  WorkspaceMap,
  WeightedAffinityMap,
  WeightedAffinityEntry,
  CorrectionEntry,
  RejectionEntry,
} from './types';
import { DEFAULT_SETTINGS, DEFAULT_STATS, DEFAULT_COSTS } from './types';

const K = {
  settings: 'settings',
  affinity: 'affinity',
  suggestions: 'suggestions',
  domainRules: 'domainRules',
  undoSnapshot: 'undoSnapshot',
  stats: 'stats',
  costs: 'costs',
  history: 'history',
  workspaces: 'workspaces',
  weightedAffinity: 'weightedAffinity',
  affinityVersion: 'affinityVersion',
  corrections: 'corrections',
  rejections: 'rejections',
  coOccurrence: 'coOccurrence',
} as const;

const MAX_HISTORY = 50;
const MAX_CORRECTIONS = 100;
const MAX_REJECTIONS = 200;
const REJECTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const MULTI_TENANT_HOSTS = new Set([
  'github.com', 'gitlab.com', 'reddit.com', 'youtube.com',
  'medium.com', 'bitbucket.org', 'notion.so', 'figma.com',
]);

// --- Settings (sync) ---

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.sync.get({ [K.settings]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...data[K.settings] };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [K.settings]: settings });
}

// --- Weighted Affinity (local) ---

export function extractPathKey(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    const hostname = u.hostname.replace(/^www\./, '');
    if (!MULTI_TENANT_HOSTS.has(hostname)) return null;
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    return `${hostname}/${segments[0]}`;
  } catch {
    return null;
  }
}

export function computeDecayedWeight(count: number, lastUsed: number, now = Date.now()): number {
  const age = now - lastUsed;
  return count * Math.exp(-age / DECAY_HALF_LIFE_MS);
}

async function migrateAffinity(): Promise<void> {
  const versionData = await chrome.storage.local.get({ [K.affinityVersion]: 0 });
  if (versionData[K.affinityVersion] >= 2) return;

  const oldData = await chrome.storage.local.get({ [K.affinity]: {} });
  const oldAffinity = oldData[K.affinity] as AffinityMap;
  const weighted: WeightedAffinityMap = {};
  const now = Date.now();

  for (const [domain, groupName] of Object.entries(oldAffinity)) {
    weighted[domain] = { groups: { [groupName]: { count: 1, lastUsed: now } } };
  }

  await chrome.storage.local.set({
    [K.weightedAffinity]: weighted,
    [K.affinityVersion]: 2,
  });
}

export async function getWeightedAffinity(): Promise<WeightedAffinityMap> {
  await migrateAffinity();
  const data = await chrome.storage.local.get({ [K.weightedAffinity]: {} });
  return data[K.weightedAffinity] as WeightedAffinityMap;
}

export function pickBestWeightedGroup(
  entry: WeightedAffinityEntry,
  rejections: RejectionEntry[],
  domain: string,
  now = Date.now(),
): string | null {
  const rejectSet = new Set(
    rejections
      .filter(r => r.domain === domain && (now - r.timestamp) < REJECTION_MAX_AGE_MS)
      .map(r => r.rejectedGroup),
  );

  let bestName: string | null = null;
  let bestWeight = 0.5; // minimum threshold

  for (const [groupName, { count, lastUsed }] of Object.entries(entry.groups)) {
    if (rejectSet.has(groupName)) continue;
    const w = computeDecayedWeight(count, lastUsed, now);
    if (w > bestWeight) {
      bestWeight = w;
      bestName = groupName;
    }
  }

  return bestName;
}

export async function updateWeightedAffinity(
  suggestions: GroupSuggestion[],
  correctionWeight = 1,
): Promise<void> {
  const current = await getWeightedAffinity();
  const now = Date.now();

  for (const group of suggestions) {
    for (const tab of group.tabs) {
      try {
        const u = new URL(tab.url);
        const domain = u.hostname.replace(/^www\./, '');
        const keys = [domain];
        const pathKey = extractPathKey(tab.url);
        if (pathKey) keys.push(pathKey);

        for (const key of keys) {
          if (!current[key]) current[key] = { groups: {} };
          const g = current[key].groups[group.name] || { count: 0, lastUsed: 0 };
          g.count += correctionWeight;
          g.lastUsed = now;
          current[key].groups[group.name] = g;
        }
      } catch { /* skip invalid URLs */ }
    }
  }

  await chrome.storage.local.set({ [K.weightedAffinity]: current });
}

// Backward-compatible facade: flattens weighted affinity to flat map
export async function getAffinity(): Promise<AffinityMap> {
  const weighted = await getWeightedAffinity();
  const flat: AffinityMap = {};
  const now = Date.now();

  for (const [key, entry] of Object.entries(weighted)) {
    // Only include domain-level entries (no path keys) in flat map
    if (key.includes('/')) continue;
    let bestName: string | null = null;
    let bestWeight = 0;
    let bestLastUsed = 0;
    for (const [groupName, { count, lastUsed }] of Object.entries(entry.groups)) {
      const w = computeDecayedWeight(count, lastUsed, now);
      // Prefer higher weight, or more recent if weights are equal
      if (w > bestWeight || (w === bestWeight && lastUsed > bestLastUsed)) {
        bestWeight = w;
        bestName = groupName;
        bestLastUsed = lastUsed;
      }
    }
    if (bestName && bestWeight > 0.5) flat[key] = bestName;
  }

  return flat;
}

export async function updateAffinity(suggestions: GroupSuggestion[]): Promise<void> {
  await updateWeightedAffinity(suggestions, 1);
}

export function formatWeightedAffinityHints(weighted: WeightedAffinityMap, now = Date.now()): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(weighted)) {
    if (key.includes('/')) continue; // skip path-level in prompt
    let bestName: string | null = null;
    let bestWeight = 0;
    let bestCount = 0;
    let bestLastUsed = 0;
    for (const [groupName, { count, lastUsed }] of Object.entries(entry.groups)) {
      const w = computeDecayedWeight(count, lastUsed, now);
      if (w > bestWeight) {
        bestWeight = w;
        bestName = groupName;
        bestCount = count;
        bestLastUsed = lastUsed;
      }
    }
    if (!bestName || bestWeight <= 0.5) continue;
    const daysAgo = Math.round((now - bestLastUsed) / (24 * 60 * 60 * 1000));
    const recency = daysAgo <= 1 ? 'recent' : `${daysAgo}d ago`;
    lines.push(`  ${key} \u2192 "${bestName}" (${bestCount}x, ${recency})`);
  }
  if (lines.length > 20) lines.length = 20;
  return lines.length
    ? `\nUser preferences (learned domain associations):\n${lines.join('\n')}\n`
    : '';
}

// --- Suggestions (local) ---

export async function getSuggestions(): Promise<GroupSuggestion[] | null> {
  const data = await chrome.storage.local.get({ [K.suggestions]: null });
  return data[K.suggestions] as GroupSuggestion[] | null;
}

export async function saveSuggestions(suggestions: GroupSuggestion[] | null): Promise<void> {
  await chrome.storage.local.set({ [K.suggestions]: suggestions });
}

// --- Domain Rules (sync) ---

export async function getDomainRules(): Promise<DomainRule[]> {
  const data = await chrome.storage.sync.get({ [K.domainRules]: [] });
  return data[K.domainRules] as DomainRule[];
}

export async function saveDomainRules(rules: DomainRule[]): Promise<void> {
  await chrome.storage.sync.set({ [K.domainRules]: rules });
}

// --- Workspaces (local) ---

export async function getWorkspaces(): Promise<WorkspaceMap> {
  const data = await chrome.storage.local.get({ [K.workspaces]: {} });
  return data[K.workspaces] as WorkspaceMap;
}

export async function saveWorkspace(name: string, workspace: Workspace): Promise<void> {
  const ws = await getWorkspaces();
  ws[name] = workspace;
  await chrome.storage.local.set({ [K.workspaces]: ws });
}

export async function removeWorkspace(name: string): Promise<void> {
  const ws = await getWorkspaces();
  delete ws[name];
  await chrome.storage.local.set({ [K.workspaces]: ws });
}

// --- Undo Snapshot (local) ---

export async function getUndoSnapshot(): Promise<UndoSnapshot | null> {
  const data = await chrome.storage.local.get({ [K.undoSnapshot]: null });
  return data[K.undoSnapshot] as UndoSnapshot | null;
}

export async function saveUndoSnapshot(snapshot: UndoSnapshot | null): Promise<void> {
  await chrome.storage.local.set({ [K.undoSnapshot]: snapshot });
}

// --- Stats (local) ---

export async function getStats(): Promise<Stats> {
  const data = await chrome.storage.local.get({ [K.stats]: DEFAULT_STATS });
  return { ...DEFAULT_STATS, ...data[K.stats] };
}

export async function incrementStats(tabsGrouped: number): Promise<Stats> {
  const current = await getStats();
  const updated: Stats = {
    totalOrganizations: current.totalOrganizations + 1,
    totalTabsGrouped: current.totalTabsGrouped + tabsGrouped,
    lastOrganizedAt: Date.now(),
  };
  await chrome.storage.local.set({ [K.stats]: updated });
  return updated;
}

// --- Costs (local) ---

export async function getCosts(): Promise<CostTotals> {
  const data = await chrome.storage.local.get({ [K.costs]: null });
  const stored = data[K.costs] as CostTotals | null;
  if (!stored) return { ...DEFAULT_COSTS, byProvider: {} };
  return { ...DEFAULT_COSTS, ...stored, byProvider: { ...stored.byProvider } };
}

export async function addCost(provider: string, inputTokens: number, outputTokens: number, cost: number): Promise<CostTotals> {
  const current = await getCosts();
  const bp = current.byProvider[provider] || { inputTokens: 0, outputTokens: 0, cost: 0 };
  current.totalInputTokens += inputTokens;
  current.totalOutputTokens += outputTokens;
  current.totalCost += cost;
  current.sessionCost += cost;
  bp.inputTokens += inputTokens;
  bp.outputTokens += outputTokens;
  bp.cost += cost;
  current.byProvider[provider] = bp;
  await chrome.storage.local.set({ [K.costs]: current });
  return current;
}

// --- History (local) ---

export async function getHistory(): Promise<HistoryEntry[]> {
  const data = await chrome.storage.local.get({ [K.history]: [] });
  return data[K.history] as HistoryEntry[];
}

export async function addHistory(suggestions: GroupSuggestion[]): Promise<void> {
  const history = await getHistory();
  const entry: HistoryEntry = {
    timestamp: Date.now(),
    groups: suggestions.map(g => ({
      name: g.name,
      domains: [...new Set(g.tabs.map(t => {
        try { return new URL(t.url).hostname; } catch { return ''; }
      }).filter(Boolean))],
    })),
  };
  history.push(entry);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await chrome.storage.local.set({ [K.history]: history });
}

export function summarizeHistory(history: HistoryEntry[]): string {
  if (!history.length) return '';
  // Build domain→group frequency map from recent history
  const freq: Record<string, Record<string, number>> = {};
  const recent = history.slice(-20);
  for (const entry of recent) {
    for (const g of entry.groups) {
      for (const d of g.domains) {
        if (!freq[d]) freq[d] = {};
        freq[d][g.name] = (freq[d][g.name] || 0) + 1;
      }
    }
  }
  // Pick top group for each domain
  const lines: string[] = [];
  for (const [domain, groups] of Object.entries(freq)) {
    const top = Object.entries(groups).sort((a, b) => b[1] - a[1])[0];
    if (top[1] >= 2) lines.push(`  ${domain} → "${top[0]}" (${top[1]}x)`);
  }
  return lines.length
    ? `\nGrouping history (frequently used assignments):\n${lines.join('\n')}\n`
    : '';
}

// --- Corrections (local) ---

export async function getCorrections(): Promise<CorrectionEntry[]> {
  const data = await chrome.storage.local.get({ [K.corrections]: [] });
  return data[K.corrections] as CorrectionEntry[];
}

export async function addCorrections(entry: CorrectionEntry): Promise<void> {
  const current = await getCorrections();
  current.push(entry);
  if (current.length > MAX_CORRECTIONS) current.splice(0, current.length - MAX_CORRECTIONS);
  await chrome.storage.local.set({ [K.corrections]: current });
}

export async function summarizeCorrections(corrections?: CorrectionEntry[]): Promise<string> {
  const entries = corrections ?? await getCorrections();
  if (!entries.length) return '';
  const freq: Record<string, Record<string, number>> = {};
  const recent = entries.slice(-30);
  for (const entry of recent) {
    for (const c of entry.corrections) {
      const key = c.domain;
      if (!freq[key]) freq[key] = {};
      const label = `"${c.originalGroup}" \u2192 "${c.correctedGroup}"`;
      freq[key][label] = (freq[key][label] || 0) + 1;
    }
  }
  const lines: string[] = [];
  for (const [domain, corrections] of Object.entries(freq)) {
    for (const [label, count] of Object.entries(corrections)) {
      if (count >= 1) lines.push(`  User corrected: ${domain} from ${label} (${count}x)`);
    }
  }
  if (lines.length > 15) lines.length = 15;
  return lines.length
    ? `\nUser corrections (strong signals — respect these):\n${lines.join('\n')}\n`
    : '';
}

// --- Rejections (local) ---

export async function getRejections(): Promise<RejectionEntry[]> {
  const data = await chrome.storage.local.get({ [K.rejections]: [] });
  const all = data[K.rejections] as RejectionEntry[];
  const now = Date.now();
  return all.filter(r => (now - r.timestamp) < REJECTION_MAX_AGE_MS);
}

export async function addRejection(domain: string, rejectedGroup: string): Promise<void> {
  const current = await getRejections();
  current.push({ timestamp: Date.now(), domain, rejectedGroup });
  if (current.length > MAX_REJECTIONS) current.splice(0, current.length - MAX_REJECTIONS);
  await chrome.storage.local.set({ [K.rejections]: current });
}

export async function addRejections(entries: RejectionEntry[]): Promise<void> {
  const current = await getRejections();
  current.push(...entries);
  if (current.length > MAX_REJECTIONS) current.splice(0, current.length - MAX_REJECTIONS);
  await chrome.storage.local.set({ [K.rejections]: current });
}

export function isRejected(domain: string, groupName: string, rejections: RejectionEntry[], now = Date.now()): boolean {
  return rejections.some(
    r => r.domain === domain && r.rejectedGroup === groupName && (now - r.timestamp) < REJECTION_MAX_AGE_MS,
  );
}

export async function summarizeRejections(rejections?: RejectionEntry[]): Promise<string> {
  const entries = rejections ?? await getRejections();
  if (!entries.length) return '';
  const freq: Record<string, Set<string>> = {};
  for (const r of entries) {
    if (!freq[r.domain]) freq[r.domain] = new Set();
    freq[r.domain].add(r.rejectedGroup);
  }
  const lines: string[] = [];
  for (const [domain, groups] of Object.entries(freq)) {
    for (const group of groups) {
      lines.push(`  AVOID: ${domain} should NOT be in "${group}"`);
    }
  }
  if (lines.length > 15) lines.length = 15;
  return lines.length
    ? `\nRejected groupings (user explicitly removed these):\n${lines.join('\n')}\n`
    : '';
}

// --- Co-occurrence (local) ---

export async function getCoOccurrence(): Promise<Record<string, number>> {
  const data = await chrome.storage.local.get({ [K.coOccurrence]: {} });
  return data[K.coOccurrence] as Record<string, number>;
}

export async function updateCoOccurrence(history: HistoryEntry[]): Promise<void> {
  const matrix: Record<string, number> = {};
  const recent = history.slice(-30);

  for (const entry of recent) {
    for (const group of entry.groups) {
      const domains = group.domains.slice(0, 20); // cap per group
      for (let i = 0; i < domains.length; i++) {
        for (let j = i + 1; j < domains.length; j++) {
          const pair = [domains[i], domains[j]].sort().join('|');
          matrix[pair] = (matrix[pair] || 0) + 1;
        }
      }
    }
  }

  await chrome.storage.local.set({ [K.coOccurrence]: matrix });
}

export async function summarizeCoOccurrence(matrix?: Record<string, number>): Promise<string> {
  const data = matrix ?? await getCoOccurrence();
  const entries = Object.entries(data).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';

  // Cluster connected domains
  const clusters: string[][] = [];
  const assigned = new Set<string>();

  for (const [pair] of entries.slice(0, 30)) {
    const [a, b] = pair.split('|');
    if (assigned.has(a) && assigned.has(b)) continue;

    let found = false;
    for (const cluster of clusters) {
      if (cluster.includes(a) || cluster.includes(b)) {
        if (!cluster.includes(a)) cluster.push(a);
        if (!cluster.includes(b)) cluster.push(b);
        assigned.add(a);
        assigned.add(b);
        found = true;
        break;
      }
    }
    if (!found) {
      clusters.push([a, b]);
      assigned.add(a);
      assigned.add(b);
    }
  }

  const lines = clusters
    .filter(c => c.length >= 2)
    .slice(0, 10)
    .map(c => `  Frequently grouped together: [${c.join(', ')}]`);

  return lines.length
    ? `\nCo-occurrence patterns (domains often in the same group):\n${lines.join('\n')}\n`
    : '';
}

// --- Export / Import ---

export async function exportAll(): Promise<ExportData> {
  const [settings, affinity, domainRules, workspaces, weightedAffinity, corrections, rejections] = await Promise.all([
    getSettings(), getAffinity(), getDomainRules(), getWorkspaces(),
    getWeightedAffinity(), getCorrections(), getRejections(),
  ]);
  return { settings, affinity, domainRules, workspaces, weightedAffinity, corrections, rejections };
}

export async function importAll(data: ExportData): Promise<void> {
  const promises: Promise<void>[] = [
    saveSettings({ ...DEFAULT_SETTINGS, ...data.settings }),
    chrome.storage.local.set({ [K.affinity]: data.affinity || {} }),
    chrome.storage.local.set({ [K.workspaces]: data.workspaces || {} }),
    saveDomainRules(data.domainRules || []),
  ];

  if (data.weightedAffinity) {
    promises.push(chrome.storage.local.set({
      [K.weightedAffinity]: data.weightedAffinity,
      [K.affinityVersion]: 2,
    }));
  }
  if (data.corrections) {
    promises.push(chrome.storage.local.set({ [K.corrections]: data.corrections }));
  }
  if (data.rejections) {
    promises.push(chrome.storage.local.set({ [K.rejections]: data.rejections }));
  }

  await Promise.all(promises);
}
