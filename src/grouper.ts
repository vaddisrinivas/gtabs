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

export function buildPrompt(
  tabs: TabInfo[],
  maxGroups: number,
  affinity: AffinityMap,
  maxTitleLength = 80,
  historyHint = '',
  extraHints?: ExtraHints,
): string {
  const tabList = tabs.map(t =>
    `  - id: ${t.id} | "${truncateTitle(t.title, maxTitleLength)}" | ${t.url}`
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

export function parseResponse(raw: string, tabs: TabInfo[]): GroupSuggestion[] {
  const validIds = new Set(tabs.map(t => t.id));
  const tabMap = new Map(tabs.map(t => [t.id, t]));

  let json = raw;
  const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlock) {
    json = codeBlock[1].trim();
  } else {
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) json = arrayMatch[0];
  }

  let parsed: RawGroup[];
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse LLM response as JSON. Length: ${raw.length}, Error: ${err}`);
  }

  if (!Array.isArray(parsed)) throw new Error('Response is not an array');

  return parsed
    .map(g => ({
      name: String(g.name || 'Unnamed'),
      color: (COLORS.includes(g.color as Color) ? g.color : 'grey') as Color,
      tabs: (g.tabIds || []).filter((id: number) => validIds.has(id)).map((id: number) => tabMap.get(id)!),
    }))
    .filter(g => g.tabs.length > 0);
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
  const prompt = buildPrompt(remaining, remainingGroups, affinity, settings.maxTitleLength, historyHint, extraHints);
  const result = await completeWithUsage(settings, [
    { role: 'system', content: 'You are a browser tab organizer. Return only valid JSON.' },
    { role: 'user', content: prompt },
  ]);
  const llmSuggestions = parseResponse(result.content, remaining);

  return {
    suggestions: [...matched, ...llmSuggestions],
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens
  };
}
