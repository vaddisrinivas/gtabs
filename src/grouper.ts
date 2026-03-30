import { completeWithUsage } from './llm';
import type { TabInfo, RawGroup, GroupSuggestion, Settings, AffinityMap, DomainRule, Color } from './types';
import { COLORS } from './types';

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

export function inferTargetGroup(urlStr: string, rules: DomainRule[], affinity: AffinityMap): { name: string, color?: Color } | null {
  let hostname = '';
  try { hostname = new URL(urlStr).hostname; } catch { return null; }

  const ruleMap = new Map(rules.map(r => [r.domain, r]));
  const rule = ruleMap.get(hostname) || ruleMap.get(hostname.replace(/^www\./, ''));
  if (rule) return { name: rule.groupName, color: rule.color };

  if (affinity[hostname]) return { name: affinity[hostname] };
  const stripped = hostname.replace(/^www\./, '');
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

export function buildPrompt(tabs: TabInfo[], maxGroups: number, affinity: AffinityMap, maxTitleLength = 80, historyHint = ''): string {
  const tabList = tabs.map(t =>
    `  - id: ${t.id} | "${truncateTitle(t.title, maxTitleLength)}" | ${t.url}`
  ).join('\n');

  const affinityEntries = Object.entries(affinity);
  const hints = affinityEntries.length > 0
    ? `\nUser preferences (group these domains together):\n${affinityEntries.map(([d, g]) => `  ${d} \u2192 "${g}"`).join('\n')}\n`
    : '';

  return `Group these browser tabs into at most ${maxGroups} logical groups.
Return ONLY a JSON array, no other text.

Rules:
- Every tab must appear in exactly one group
- Use short group names (1-3 words)
- Valid colors: ${COLORS.join(', ')}
- Use tabIds from the list below exactly as given

Format: [{"name":"Group","color":"blue","tabIds":[1,2]}]
${hints}${historyHint}
Tabs:
${tabList}`;
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
): Promise<{ suggestions: GroupSuggestion[], inputTokens: number, outputTokens: number }> {
  const { matched, remaining } = applyDomainRules(tabs, domainRules);

  if (remaining.length === 0) return { suggestions: matched, inputTokens: 0, outputTokens: 0 };

  const remainingGroups = Math.max(1, settings.maxGroups - matched.length);
  const prompt = buildPrompt(remaining, remainingGroups, affinity, settings.maxTitleLength, historyHint);
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
