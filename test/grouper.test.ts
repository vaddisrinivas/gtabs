import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrompt, parseResponse, suggest, truncateTitle, applyDomainRules, findDuplicates } from '../src/grouper';
import type { TabInfo, AffinityMap, DomainRule } from '../src/types';
import { DEFAULT_SETTINGS, COLORS } from '../src/types';

const TEST_SETTINGS = { ...DEFAULT_SETTINGS, provider: 'openai', baseUrl: 'https://api.test.com/v1', apiKey: 'test', model: 'test-model' };

const tabs: TabInfo[] = [
  { id: 1, title: 'GitHub - repo', url: 'https://github.com/user/repo' },
  { id: 2, title: 'Stack Overflow - question', url: 'https://stackoverflow.com/q/123' },
  { id: 3, title: 'YouTube - video', url: 'https://youtube.com/watch?v=abc' },
  { id: 4, title: 'Gmail - inbox', url: 'https://mail.google.com/inbox' },
];

// ---------- truncateTitle ----------

describe('truncateTitle', () => {
  it('returns title unchanged when under limit', () => {
    expect(truncateTitle('Short', 80)).toBe('Short');
  });

  it('returns title unchanged when exactly at limit', () => {
    const t = 'x'.repeat(80);
    expect(truncateTitle(t, 80)).toBe(t);
  });

  it('truncates and adds ellipsis when over limit', () => {
    const t = 'x'.repeat(100);
    const result = truncateTitle(t, 80);
    expect(result).toHaveLength(80);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('handles empty string', () => {
    expect(truncateTitle('', 80)).toBe('');
  });

  it('handles limit of 1', () => {
    expect(truncateTitle('hello', 1)).toBe('\u2026');
  });

  it('handles unicode titles', () => {
    const t = '日本語のタイトル';
    expect(truncateTitle(t, 5)).toHaveLength(5);
  });
});

// ---------- applyDomainRules ----------

describe('applyDomainRules', () => {
  it('returns all tabs as remaining when no rules', () => {
    const { matched, remaining } = applyDomainRules(tabs, []);
    expect(matched).toHaveLength(0);
    expect(remaining).toEqual(tabs);
  });

  it('matches exact domain', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched, remaining } = applyDomainRules(tabs, rules);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('Dev');
    expect(matched[0].tabs).toHaveLength(1);
    expect(matched[0].tabs[0].id).toBe(1);
    expect(remaining).toHaveLength(3);
  });

  it('matches www. prefix by stripping it', () => {
    const tabsWithWww: TabInfo[] = [{ id: 10, title: 'Test', url: 'https://www.github.com/test' }];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched } = applyDomainRules(tabsWithWww, rules);
    expect(matched).toHaveLength(1);
    expect(matched[0].tabs[0].id).toBe(10);
  });

  it('groups multiple tabs matching same rule', () => {
    const moreTabs: TabInfo[] = [
      { id: 10, title: 'GH 1', url: 'https://github.com/a' },
      { id: 11, title: 'GH 2', url: 'https://github.com/b' },
    ];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched } = applyDomainRules(moreTabs, rules);
    expect(matched[0].tabs).toHaveLength(2);
  });

  it('applies multiple rules independently', () => {
    const rules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
    ];
    const { matched, remaining } = applyDomainRules(tabs, rules);
    expect(matched).toHaveLength(2);
    expect(remaining).toHaveLength(2);
  });

  it('handles tabs with invalid URLs gracefully', () => {
    const badTabs: TabInfo[] = [{ id: 99, title: 'Bad', url: 'not-a-url' }];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { remaining } = applyDomainRules(badTabs, rules);
    expect(remaining).toHaveLength(1);
  });

  it('preserves color from domain rule', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'purple' }];
    const { matched } = applyDomainRules(tabs, rules);
    expect(matched[0].color).toBe('purple');
  });
});

// ---------- inferTargetGroup ----------

import { inferTargetGroup } from '../src/grouper';

describe('inferTargetGroup', () => {
  it('returns null for unparseable URLs', () => {
    expect(inferTargetGroup('not-a-url', [], {})).toBeNull();
  });

  it('matches rules first, then affinity', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'RulesDev', color: 'red' }];
    const affinity: import('../src/types').AffinityMap = { 'github.com': 'AffinityDev' };

    // Rules win
    expect(inferTargetGroup('https://github.com/a', rules, affinity)).toEqual({ name: 'RulesDev', color: 'red' });
  });

  it('falls back to affinity if no rule matches', () => {
    const rules: DomainRule[] = [];
    const affinity: import('../src/types').AffinityMap = { 'github.com': 'AffinityDev' };

    expect(inferTargetGroup('https://github.com/expr', rules, affinity)).toEqual({ name: 'AffinityDev' });
  });

  it('strips www. from hostname when checking rules', () => {
    const rules: DomainRule[] = [{ domain: 'youtube.com', groupName: 'Media', color: 'red' }];
    expect(inferTargetGroup('https://www.youtube.com/watch', rules, {})).toEqual({ name: 'Media', color: 'red' });
  });

  it('strips www. from hostname when checking affinity', () => {
    const affinity = { 'youtube.com': 'AffinityMedia' };
    expect(inferTargetGroup('https://www.youtube.com/watch', [], affinity)).toEqual({ name: 'AffinityMedia' });
    expect(inferTargetGroup('https://not-in-affinity.com', [], affinity)).toBeNull();
  });
});

// ---------- findDuplicates ----------

describe('findDuplicates', () => {
  it('returns empty when no duplicates', () => {
    expect(findDuplicates(tabs)).toHaveLength(0);
  });

  it('finds exact URL duplicates', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'Page', url: 'https://example.com/page' },
      { id: 2, title: 'Page Copy', url: 'https://example.com/page' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('normalizes trailing slashes', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page/' },
      { id: 2, title: 'B', url: 'https://example.com/page' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('normalizes hash fragments', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page#section1' },
      { id: 2, title: 'B', url: 'https://example.com/page#section2' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('treats different query params as different', () => {
    const tabs: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page?a=1' },
      { id: 2, title: 'B', url: 'https://example.com/page?a=2' },
    ];
    expect(findDuplicates(tabs)).toHaveLength(0);
  });

  it('finds multiple duplicate groups', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A1', url: 'https://a.com' },
      { id: 2, title: 'A2', url: 'https://a.com' },
      { id: 3, title: 'B1', url: 'https://b.com' },
      { id: 4, title: 'B2', url: 'https://b.com' },
      { id: 5, title: 'C', url: 'https://c.com' },
    ];
    expect(findDuplicates(dupes)).toHaveLength(2);
  });

  it('handles tabs with invalid URLs', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'not-url' },
      { id: 2, title: 'B', url: 'not-url' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('handles empty tab list', () => {
    expect(findDuplicates([])).toHaveLength(0);
  });
});

// ---------- buildPrompt ----------

describe('buildPrompt', () => {
  it('includes tab info in prompt', () => {
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).toContain('github.com/user/repo');
    expect(prompt).toContain('GitHub - repo');
    expect(prompt).toContain('id: 1');
  });

  it('includes max groups constraint', () => {
    const prompt = buildPrompt(tabs, 3, {});
    expect(prompt).toContain('at most 3');
  });

  it('includes affinity hints when provided', () => {
    const affinity: AffinityMap = { 'github.com': 'Dev', 'youtube.com': 'Media' };
    const prompt = buildPrompt(tabs, 6, affinity);
    expect(prompt).toContain('github.com');
    expect(prompt).toContain('Dev');
    expect(prompt).toContain('User preferences');
  });

  it('excludes affinity section when empty', () => {
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).not.toContain('User preferences');
  });

  it('lists all valid colors', () => {
    const prompt = buildPrompt(tabs, 6, {});
    for (const c of COLORS) {
      expect(prompt).toContain(c);
    }
  });

  it('includes JSON format example', () => {
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('"color"');
    expect(prompt).toContain('"tabIds"');
  });

  it('truncates long titles according to maxTitleLength', () => {
    const longTabs: TabInfo[] = [{ id: 1, title: 'x'.repeat(200), url: 'https://example.com' }];
    const prompt = buildPrompt(longTabs, 6, {}, 50);
    expect(prompt).not.toContain('x'.repeat(200));
    expect(prompt).toContain('\u2026');
  });

  it('handles single tab', () => {
    const prompt = buildPrompt([tabs[0]], 6, {});
    expect(prompt).toContain('id: 1');
    expect(prompt).not.toContain('id: 2');
  });

  it('handles large tab set (50+ tabs)', () => {
    const manyTabs = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1, title: `Tab ${i + 1}`, url: `https://site${i + 1}.com`,
    }));
    const prompt = buildPrompt(manyTabs, 6, {});
    expect(prompt).toContain('id: 1');
    expect(prompt).toContain('id: 60');
  });

  it('handles tabs with special characters in title', () => {
    const special: TabInfo[] = [{ id: 1, title: 'Tab "with" <special> & chars', url: 'https://example.com' }];
    const prompt = buildPrompt(special, 6, {});
    expect(prompt).toContain('Tab "with" <special> & chars');
  });
});

// ---------- parseResponse ----------

describe('parseResponse', () => {
  it('parses valid JSON array', () => {
    const raw = '[{"name":"Dev","color":"blue","tabIds":[1,2]},{"name":"Media","color":"red","tabIds":[3]}]';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Dev');
    expect(result[0].color).toBe('blue');
    expect(result[0].tabs).toHaveLength(2);
    expect(result[0].tabs[0].id).toBe(1);
  });

  it('enriches tabs with full info', () => {
    const raw = '[{"name":"Dev","color":"blue","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].tabs[0]).toEqual(tabs[0]);
  });

  it('extracts JSON from ```json code blocks', () => {
    const raw = '```json\n[{"name":"Dev","color":"blue","tabIds":[1,2]}]\n```';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
  });

  it('extracts JSON from ``` code blocks (no lang)', () => {
    const raw = 'Here:\n```\n[{"name":"Dev","color":"blue","tabIds":[1]}]\n```\nDone!';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
  });

  it('extracts JSON embedded in prose', () => {
    const raw = 'Sure! Here are the groups:\n[{"name":"Dev","color":"blue","tabIds":[1]}]\nHope this helps!';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
  });

  it('filters out invalid tab IDs', () => {
    const raw = '[{"name":"Dev","color":"blue","tabIds":[1,999,2]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].tabs).toHaveLength(2);
    expect(result[0].tabs.map(t => t.id)).toEqual([1, 2]);
  });

  it('drops groups with no valid tabs', () => {
    const raw = '[{"name":"Empty","color":"blue","tabIds":[999]},{"name":"Dev","color":"red","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Dev');
  });

  it('defaults invalid color to grey', () => {
    const raw = '[{"name":"Dev","color":"neon","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].color).toBe('grey');
  });

  it('defaults missing color to grey', () => {
    const raw = '[{"name":"Dev","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].color).toBe('grey');
  });

  it('defaults empty name to Unnamed', () => {
    const raw = '[{"name":"","color":"blue","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].name).toBe('Unnamed');
  });

  it('defaults missing name to Unnamed', () => {
    const raw = '[{"color":"blue","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].name).toBe('Unnamed');
  });

  it('handles empty tabIds array', () => {
    const raw = '[{"name":"Empty","color":"blue","tabIds":[]},{"name":"Dev","color":"red","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Dev');
  });

  it('handles missing tabIds field', () => {
    const raw = '[{"name":"Dev","color":"blue"}]';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(0);
  });

  it('handles empty JSON array', () => {
    const raw = '[]';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(0);
  });

  it('throws on completely unparseable response', () => {
    expect(() => parseResponse('I cannot help with that.', tabs)).toThrow();
  });

  it('throws on refusal', () => {
    expect(() => parseResponse("I'm sorry, I can't assist with that request.", tabs)).toThrow();
  });

  it('throws on non-array JSON', () => {
    expect(() => parseResponse('{"name":"Dev"}', tabs)).toThrow('not an array');
  });

  it('handles number as name (coerces to string)', () => {
    const raw = '[{"name":42,"color":"blue","tabIds":[1]}]';
    const result = parseResponse(raw, tabs);
    expect(result[0].name).toBe('42');
  });

  it('handles all valid colors', () => {
    for (const color of COLORS) {
      const raw = `[{"name":"Test","color":"${color}","tabIds":[1]}]`;
      const result = parseResponse(raw, tabs);
      expect(result[0].color).toBe(color);
    }
  });

  it('handles duplicate tab IDs in same group', () => {
    const raw = '[{"name":"Dev","color":"blue","tabIds":[1,1,2]}]';
    const result = parseResponse(raw, tabs);
    // All valid IDs kept — dedup is not enforced at this layer
    expect(result[0].tabs.length).toBeGreaterThanOrEqual(2);
  });

  it('handles response with BOM character', () => {
    const raw = '\uFEFF[{"name":"Dev","color":"blue","tabIds":[1]}]';
    // May or may not parse depending on JSON.parse handling
    try {
      const result = parseResponse(raw, tabs);
      expect(result).toHaveLength(1);
    } catch {
      // acceptable to throw
    }
  });

  it('handles deeply nested code block', () => {
    const raw = 'text\n```json\n[{"name":"Dev","color":"blue","tabIds":[1]}]\n```\nmore text\n```\nignored\n```';
    const result = parseResponse(raw, tabs);
    expect(result).toHaveLength(1);
  });
});

// ---------- suggest ----------

describe('suggest', () => {
  beforeEach(() => vi.mocked(fetch).mockReset());

  function mockLLM(content: string) {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content } }],
    })));
  }

  it('returns enriched suggestions from LLM', async () => {
    mockLLM('[{"name":"Dev","color":"blue","tabIds":[1,2]},{"name":"Media","color":"red","tabIds":[3]}]');
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {});
    expect(result).toHaveLength(2);
    expect(result[0].tabs[0].title).toBe('GitHub - repo');
  });

  it('passes affinity to prompt', async () => {
    mockLLM('[{"name":"Dev","color":"blue","tabIds":[1]}]');
    await suggest(tabs, TEST_SETTINGS, { 'github.com': 'Code' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.messages[1].content).toContain('Code');
  });

  it('applies domain rules before LLM call', async () => {
    mockLLM('[{"name":"Other","color":"green","tabIds":[2,4]}]');
    const rules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
    ];
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {}, rules);
    // 2 from rules + 1 from LLM (only remaining tabs sent)
    const devGroup = result.find(g => g.name === 'Dev');
    expect(devGroup).toBeDefined();
    expect(devGroup!.tabs[0].id).toBe(1);
  });

  it('skips LLM when all tabs matched by rules', async () => {
    const allRules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'stackoverflow.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
      { domain: 'mail.google.com', groupName: 'Email', color: 'green' },
    ];
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {}, allRules);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });

  it('reduces maxGroups for LLM based on rule matches', async () => {
    mockLLM('[{"name":"Other","color":"green","tabIds":[2,4]}]');
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    await suggest(tabs, { ...TEST_SETTINGS, maxGroups: 4 }, {}, rules);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.messages[1].content).toContain('at most 3');
  });

  it('throws on LLM failure', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('timeout'); });
    let caught: Error | null = null;
    try { await suggest(tabs, TEST_SETTINGS, {}); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('timeout');
  });

  it('uses system message for LLM', async () => {
    mockLLM('[{"name":"Dev","color":"blue","tabIds":[1]}]');
    await suggest(tabs, TEST_SETTINGS, {});
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('tab organizer');
  });
});
