import { completeWithUsage } from './llm';
import type {
  TabInfo, RawGroup, GroupSuggestion, Settings, AffinityMap, DomainRule, Color,
  WeightedAffinityMap, RejectionEntry,
} from './types';
import { COLORS } from './types';
import { extractPathKey, computeDecayedWeight, pickBestWeightedGroup } from './storage';

export function truncateTitle(title: string, maxLen: number): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 1) + '\u2026';
}

export function applyDomainRules(tabs: TabInfo[], rules: DomainRule[]): { matched: GroupSuggestion[]; remaining: TabInfo[] } {
  if (!rules.length) return { matched: [], remaining: tabs };

  const ruleMap = new Map(rules.map(r => [r.domain, r]));
  const groups = new Map<string, { rule: DomainRule; tabs: TabInfo[] }>();
  const remaining: TabInfo[] = [];

  for (const tab of tabs) {
    let hostname = '';
    try { hostname = new URL(tab.url).hostname; } catch { remaining.push(tab); continue; }

    const rule = ruleMap.get(hostname) || ruleMap.get(hostname.replace(/^www\./, ''));
    if (rule) {
      const key = rule.domain;
      if (!groups.has(key)) groups.set(key, { rule, tabs: [] });
      groups.get(key)!.tabs.push(tab);
    } else {
      remaining.push(tab);
    }
  }

  const matched = Array.from(groups.values()).map(({ rule, tabs }) => ({
    name: rule.groupName,
    color: rule.color,
    tabs,
  }));

  return { matched, remaining };
}

export function inferTargetGroup(
  urlStr: string,
  rules: DomainRule[],
  affinity: AffinityMap,
  weightedAffinity?: WeightedAffinityMap,
  rejections?: RejectionEntry[],
): { name: string, color?: Color } | null {
  let hostname = '';
  try { hostname = new URL(urlStr).hostname; } catch { return null; }

  // 1. Domain rules (highest priority)
  const ruleMap = new Map(rules.map(r => [r.domain, r]));
  const rule = ruleMap.get(hostname) || ruleMap.get(hostname.replace(/^www\./, ''));
  if (rule) return { name: rule.groupName, color: rule.color };

  const stripped = hostname.replace(/^www\./, '');

  // 2. Weighted affinity — path-level first, then domain-level
  if (weightedAffinity) {
    const rejects = rejections || [];

    // Path-level
    const pathKey = extractPathKey(urlStr);
    if (pathKey && weightedAffinity[pathKey]) {
      const best = pickBestWeightedGroup(weightedAffinity[pathKey], rejects, stripped);
      if (best) return { name: best };
    }

    // Domain-level
    const domainEntry = weightedAffinity[stripped] || weightedAffinity[hostname];
    if (domainEntry) {
      const best = pickBestWeightedGroup(domainEntry, rejects, stripped);
      if (best) return { name: best };
    }
  }

  // 3. Flat affinity fallback
  if (affinity[hostname]) return { name: affinity[hostname] };
  if (affinity[stripped]) return { name: affinity[stripped] };

  return null;
}

export function findDuplicates(tabs: TabInfo[]): TabInfo[][] {
  const byUrl = new Map<string, TabInfo[]>();
  for (const tab of tabs) {
    let key = tab.url;
    try {
      const u = new URL(key);
      u.hash = '';
      key = u.toString().replace(/\/$/, '');
    } catch {}
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key)!.push(tab);
  }
  return Array.from(byUrl.values()).filter(g => g.length > 1);
}

export interface ExtraHints {
  affinityHint?: string;
  corrections?: string;
  rejections?: string;
  coOccurrence?: string;
  openers?: string;
}

/** Strip characters that could break JSON or inject prompt instructions */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPrompt(
  tabs: TabInfo[],
  maxGroups: number,
  affinity: AffinityMap,
  maxTitleLength = 80,
  historyHint = '',
  extraHints?: ExtraHints,
): string {
  const tabList = tabs.map(t =>
    `  - id: ${t.id} | "${sanitizeForPrompt(truncateTitle(t.title, maxTitleLength))}" | ${sanitizeForPrompt(t.url)}`
  ).join('\n');

  // Use weighted affinity hint if available, otherwise fall back to flat
  let hints = '';
  if (extraHints?.affinityHint) {
    hints = extraHints.affinityHint;
  } else {
    const affinityEntries = Object.entries(affinity);
    hints = affinityEntries.length > 0
      ? `\nUser preferences (group these domains together):\n${affinityEntries.map(([d, g]) => `  ${d} \u2192 "${g}"`).join('\n')}\n`
      : '';
  }

  const extra = [
    extraHints?.corrections || '',
    extraHints?.rejections || '',
    extraHints?.coOccurrence || '',
    extraHints?.openers || '',
  ].filter(Boolean).join('');

  return `Group these browser tabs into at most ${maxGroups} logical groups.
Return ONLY a JSON array, no other text.

Rules:
- Every tab must appear in exactly one group
- Use short group names (1-3 words)
- Valid colors: ${COLORS.join(', ')}
- Use tabIds from the list below exactly as given

Format: [{"name":"Group","color":"blue","tabIds":[1,2]}]
${hints}${historyHint}${extra}
Tabs:
${tabList}`;
}

// --- Title Matching (for smart merge mode) ---

export function tokenizeTitle(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);
}

export function titleGroupSimilarity(tabTitle: string, groupName: string): number {
  const titleTokens = new Set(tokenizeTitle(tabTitle));
  const groupTokens = new Set(tokenizeTitle(groupName));
  if (titleTokens.size === 0 || groupTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of groupTokens) {
    if (titleTokens.has(token)) intersection++;
  }

  const union = new Set([...titleTokens, ...groupTokens]).size;
  return union > 0 ? intersection / union : 0;
}

export function matchTabsToExistingGroups(
  tabs: TabInfo[],
  groupNames: string[],
  threshold = 0.3,
): { matched: Map<string, TabInfo[]>; remaining: TabInfo[] } {
  const matched = new Map<string, TabInfo[]>();
  const remaining: TabInfo[] = [];

  for (const tab of tabs) {
    let bestGroup: string | null = null;
    let bestScore = threshold;

    for (const name of groupNames) {
      const score = titleGroupSimilarity(tab.title, name);
      if (score > bestScore) {
        bestScore = score;
        bestGroup = name;
      }
    }

    if (bestGroup) {
      if (!matched.has(bestGroup)) matched.set(bestGroup, []);
      matched.get(bestGroup)!.push(tab);
    } else {
      remaining.push(tab);
    }
  }

  return { matched, remaining };
}

function extractJSON(raw: string): string {
  // Try code block first
  const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlock) return codeBlock[1].trim();

  // Try raw array
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  return raw;
}

function validateGroup(g: unknown): g is RawGroup {
  if (typeof g !== 'object' || g === null) return false;
  const obj = g as Record<string, unknown>;
  if (!Array.isArray(obj.tabIds)) return false;
  return true;
}

export function parseResponse(raw: string, tabs: TabInfo[]): GroupSuggestion[] {
  const validIds = new Set(tabs.map(t => t.id));
  const tabMap = new Map(tabs.map(t => [t.id, t]));

  const json = extractJSON(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse LLM response as JSON. Length: ${raw.length}, Error: ${err}`);
  }

  if (!Array.isArray(parsed)) throw new Error('Response is not an array');

  const assignedIds = new Set<number>();

  const groups = parsed
    .filter(validateGroup)
    .map(g => {
      const name = String(g.name || 'Unnamed').slice(0, 50);
      const color = (COLORS.includes(g.color as Color) ? g.color : 'grey') as Color;
      const tabIds = g.tabIds
        .map((id: unknown) => typeof id === 'number' ? id : Number(id))
        .filter((id: number) => !isNaN(id) && validIds.has(id) && !assignedIds.has(id));
      for (const id of tabIds) assignedIds.add(id);
      return { name, color, tabs: tabIds.map((id: number) => tabMap.get(id)!) };
    })
    .filter(g => g.tabs.length > 0);

  return groups;
}

/** Collect any tabs the LLM forgot into an "Other" group */
export function collectUnassigned(groups: GroupSuggestion[], allTabs: TabInfo[]): GroupSuggestion[] {
  const assignedIds = new Set(groups.flatMap(g => g.tabs.map(t => t.id)));
  const missing = allTabs.filter(t => !assignedIds.has(t.id));
  if (missing.length > 0) {
    return [...groups, { name: 'Other', color: 'grey' as Color, tabs: missing }];
  }
  return groups;
}

const CHUNK_SIZE = 60;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function mergeSuggestions(chunks: GroupSuggestion[][]): GroupSuggestion[] {
  const byName = new Map<string, GroupSuggestion>();
  const globalAssignedIds = new Set<number>();
  for (const suggestions of chunks) {
    for (const g of suggestions) {
      const key = g.name.toLowerCase();
      // Deduplicate tabs that were assigned across multiple chunks
      const newTabs = g.tabs.filter(t => !globalAssignedIds.has(t.id));
      for (const t of newTabs) globalAssignedIds.add(t.id);
      if (byName.has(key)) {
        byName.get(key)!.tabs.push(...newTabs);
      } else {
        byName.set(key, { ...g, tabs: newTabs });
      }
    }
  }
  return Array.from(byName.values()).filter(g => g.tabs.length > 0);
}

export async function suggest(
  tabs: TabInfo[],
  settings: Settings,
  affinity: AffinityMap,
  domainRules: DomainRule[] = [],
  historyHint = '',
  extraHints?: ExtraHints,
): Promise<{ suggestions: GroupSuggestion[], inputTokens: number, outputTokens: number }> {
  const { matched, remaining } = applyDomainRules(tabs, domainRules);

  if (remaining.length === 0) return { suggestions: matched, inputTokens: 0, outputTokens: 0 };

  const remainingGroups = Math.max(1, settings.maxGroups - matched.length);
  const chunks = chunkArray(remaining, CHUNK_SIZE);

  let totalInput = 0;
  let totalOutput = 0;
  const chunkResults: GroupSuggestion[][] = [];

  for (const chunk of chunks) {
    const prompt = buildPrompt(chunk, remainingGroups, affinity, settings.maxTitleLength, historyHint, extraHints);
    const result = await completeWithUsage(settings, [
      { role: 'system', content: 'You are a browser tab organizer. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ]);
    chunkResults.push(parseResponse(result.content, chunk));
    totalInput += result.inputTokens;
    totalOutput += result.outputTokens;
  }

  const merged = chunks.length > 1 ? mergeSuggestions(chunkResults) : chunkResults[0];
  const llmSuggestions = collectUnassigned(merged, remaining);

  return {
    suggestions: [...matched, ...llmSuggestions],
    inputTokens: totalInput,
    outputTokens: totalOutput,
  };
}
