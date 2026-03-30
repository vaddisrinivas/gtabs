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
} as const;

const MAX_HISTORY = 50;

// --- Settings (sync) ---

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.sync.get({ [K.settings]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...data[K.settings] };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [K.settings]: settings });
}

// --- Affinity (local) ---

export async function getAffinity(): Promise<AffinityMap> {
  const data = await chrome.storage.local.get({ [K.affinity]: {} });
  return data[K.affinity] as AffinityMap;
}

export async function updateAffinity(suggestions: GroupSuggestion[]): Promise<void> {
  const current = await getAffinity();
  for (const group of suggestions) {
    for (const tab of group.tabs) {
      try {
        const domain = new URL(tab.url).hostname;
        current[domain] = group.name;
      } catch { /* skip invalid URLs */ }
    }
  }
  await chrome.storage.local.set({ [K.affinity]: current });
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

// --- Export / Import ---

export async function exportAll(): Promise<ExportData> {
  const [settings, affinity, domainRules, workspaces] = await Promise.all([
    getSettings(), getAffinity(), getDomainRules(), getWorkspaces(),
  ]);
  return { settings, affinity, domainRules, workspaces };
}

export async function importAll(data: ExportData): Promise<void> {
  await Promise.all([
    saveSettings({ ...DEFAULT_SETTINGS, ...data.settings }),
    chrome.storage.local.set({ [K.affinity]: data.affinity || {} }),
    chrome.storage.local.set({ [K.workspaces]: data.workspaces || {} }),
    saveDomainRules(data.domainRules || []),
  ]);
}
