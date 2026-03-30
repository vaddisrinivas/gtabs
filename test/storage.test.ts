import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetStores } from './setup';
import {
  getSettings, saveSettings,
  getAffinity, updateAffinity,
  getSuggestions, saveSuggestions,
  getDomainRules, saveDomainRules,
  getUndoSnapshot, saveUndoSnapshot,
  getStats, incrementStats,
  getCosts, addCost,
  getHistory, addHistory, summarizeHistory,
  exportAll, importAll,
  getWorkspaces, saveWorkspace, removeWorkspace
} from '../src/storage';
import { DEFAULT_SETTINGS, DEFAULT_STATS, DEFAULT_COSTS } from '../src/types';
import type { GroupSuggestion, DomainRule, UndoSnapshot, ExportData } from '../src/types';

beforeEach(() => resetStores());

// ---------- Settings ----------

describe('settings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('saves and retrieves all fields', async () => {
    const custom = { ...DEFAULT_SETTINGS, model: 'gpt-4o', maxGroups: 4, mergeMode: true, provider: 'openai' };
    await saveSettings(custom);
    const s = await getSettings();
    expect(s.model).toBe('gpt-4o');
    expect(s.provider).toBe('openai');
  });

  it('merges partial updates with defaults', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-123' });
    const s = await getSettings();
    expect(s.apiKey).toBe('sk-123');
    expect(s.provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it('preserves all default fields', async () => {
    const s = await getSettings();
    expect(s).toHaveProperty('provider');
    expect(s).toHaveProperty('model');
    expect(s).toHaveProperty('maxGroups');
    expect(s).toHaveProperty('silentAutoAdd');
    expect(s).toHaveProperty('autoPinApps');
  });

  it('overwrites previous settings completely', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, model: 'first' });
    await saveSettings({ ...DEFAULT_SETTINGS, model: 'second' });
    expect((await getSettings()).model).toBe('second');
  });
});

// ---------- Affinity ----------

describe('affinity', () => {
  it('returns empty map when nothing stored', async () => {
    expect(await getAffinity()).toEqual({});
  });

  it('updates affinity from suggestions', async () => {
    await updateAffinity([
      { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com/repo' }] },
    ]);
    expect((await getAffinity())['github.com']).toBe('Dev');
  });

  it('overwrites existing affinity', async () => {
    await updateAffinity([{ name: 'Old', color: 'blue', tabs: [{ id: 1, title: '', url: 'https://github.com/x' }] }]);
    await updateAffinity([{ name: 'New', color: 'red', tabs: [{ id: 1, title: '', url: 'https://github.com/y' }] }]);
    expect((await getAffinity())['github.com']).toBe('New');
  });

  it('preserves unrelated domains', async () => {
    await updateAffinity([{ name: 'A', color: 'blue', tabs: [{ id: 1, title: '', url: 'https://a.com' }] }]);
    await updateAffinity([{ name: 'B', color: 'red', tabs: [{ id: 2, title: '', url: 'https://b.com' }] }]);
    const a = await getAffinity();
    expect(a['a.com']).toBe('A');
    expect(a['b.com']).toBe('B');
  });

  it('skips invalid URLs', async () => {
    await updateAffinity([{ name: 'X', color: 'blue', tabs: [{ id: 1, title: '', url: 'not-url' }] }]);
    expect(await getAffinity()).toEqual({});
  });
});

// ---------- Suggestions ----------

describe('suggestions', () => {
  it('returns null when nothing stored', async () => {
    expect(await getSuggestions()).toBeNull();
  });

  it('saves and retrieves', async () => {
    const s: GroupSuggestion[] = [{ name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com' }] }];
    await saveSuggestions(s);
    expect(await getSuggestions()).toEqual(s);
  });

  it('clears when null', async () => {
    await saveSuggestions([{ name: 'X', color: 'blue', tabs: [] }]);
    await saveSuggestions(null);
    expect(await getSuggestions()).toBeNull();
  });
});

// ---------- Domain Rules ----------

describe('domain rules', () => {
  it('returns empty array by default', async () => {
    expect(await getDomainRules()).toEqual([]);
  });

  it('saves and retrieves rules', async () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    await saveDomainRules(rules);
    expect(await getDomainRules()).toEqual(rules);
  });

  it('overwrites on save', async () => {
    await saveDomainRules([{ domain: 'a.com', groupName: 'A', color: 'blue' }]);
    await saveDomainRules([{ domain: 'b.com', groupName: 'B', color: 'red' }]);
    const rules = await getDomainRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe('b.com');
  });
});

// ---------- Undo Snapshot ----------

describe('undo snapshot', () => {
  it('returns null by default', async () => {
    expect(await getUndoSnapshot()).toBeNull();
  });

  it('saves and retrieves', async () => {
    const snap: UndoSnapshot = { timestamp: 123, groups: [{ tabId: 1, groupId: 100 }], ungrouped: [2] };
    await saveUndoSnapshot(snap);
    expect(await getUndoSnapshot()).toEqual(snap);
  });

  it('clears when null', async () => {
    await saveUndoSnapshot({ timestamp: 1, groups: [], ungrouped: [] });
    await saveUndoSnapshot(null);
    expect(await getUndoSnapshot()).toBeNull();
  });
});

// ---------- Stats ----------

describe('stats', () => {
  it('returns defaults', async () => {
    expect(await getStats()).toEqual(DEFAULT_STATS);
  });

  it('increments', async () => {
    await incrementStats(5);
    const s = await getStats();
    expect(s.totalOrganizations).toBe(1);
    expect(s.totalTabsGrouped).toBe(5);
  });

  it('accumulates', async () => {
    await incrementStats(5);
    await incrementStats(10);
    const s = await getStats();
    expect(s.totalOrganizations).toBe(2);
    expect(s.totalTabsGrouped).toBe(15);
  });
});

// ---------- Costs ----------

describe('costs', () => {
  beforeEach(() => resetStores());

  it('returns defaults', async () => {
    expect(await getCosts()).toEqual(DEFAULT_COSTS);
  });

  it('adds cost entry', async () => {
    const c = await addCost('anthropic', 1000, 500, 0.01);
    expect(c.totalInputTokens).toBe(1000);
    expect(c.totalOutputTokens).toBe(500);
    expect(c.totalCost).toBe(0.01);
    expect(c.byProvider['anthropic'].cost).toBe(0.01);
  });

  it('accumulates across providers', async () => {
    await addCost('anthropic', 1000, 500, 0.01);
    await addCost('openai', 2000, 800, 0.02);
    const c = await getCosts();
    expect(c.totalCost).toBeCloseTo(0.03);
    expect(Object.keys(c.byProvider)).toHaveLength(2);
  });

  it('accumulates same provider', async () => {
    await addCost('anthropic', 1000, 500, 0.01);
    await addCost('anthropic', 2000, 800, 0.02);
    const c = await getCosts();
    expect(c.byProvider['anthropic'].inputTokens).toBe(3000);
    expect(c.byProvider['anthropic'].cost).toBeCloseTo(0.03);
  });
});

// ---------- History ----------

describe('history', () => {
  it('returns empty array by default', async () => {
    expect(await getHistory()).toEqual([]);
  });

  it('adds history entry from suggestions', async () => {
    const suggestions: GroupSuggestion[] = [
      { name: 'Dev', color: 'blue', tabs: [
        { id: 1, title: 'GH', url: 'https://github.com/repo' },
        { id: 2, title: 'SO', url: 'https://stackoverflow.com/q' },
      ] },
    ];
    await addHistory(suggestions);
    const h = await getHistory();
    expect(h).toHaveLength(1);
    expect(h[0].groups[0].name).toBe('Dev');
    expect(h[0].groups[0].domains).toContain('github.com');
    expect(h[0].groups[0].domains).toContain('stackoverflow.com');
  });

  it('deduplicates domains in same group', async () => {
    const suggestions: GroupSuggestion[] = [
      { name: 'Dev', color: 'blue', tabs: [
        { id: 1, title: 'GH1', url: 'https://github.com/a' },
        { id: 2, title: 'GH2', url: 'https://github.com/b' },
      ] },
    ];
    await addHistory(suggestions);
    const h = await getHistory();
    expect(h[0].groups[0].domains).toEqual(['github.com']);
  });

  it('drops invalid URLs when building history domains', async () => {
    const suggestions: GroupSuggestion[] = [
      { name: 'Misc', color: 'blue', tabs: [
        { id: 1, title: 'A', url: 'not-a-url' },
        { id: 2, title: 'B', url: 'https://valid.com' },
      ] },
    ];
    await addHistory(suggestions);
    const h = await getHistory();
    expect(h[0].groups[0].domains).toEqual(['valid.com']);
  });

  it('truncates history beyond MAX_HISTORY', async () => {
    // Add 51 entries
    for (let i = 0; i < 51; i++) {
        await addHistory([{ name: `Dev${i}`, color: 'blue', tabs: [] }]);
    }
    const h = await getHistory();
    expect(h).toHaveLength(50);
    expect(h[49].groups[0].name).toBe('Dev50'); // the last one added
  });

  it('summarizeHistory returns empty for no history', () => {
    expect(summarizeHistory([])).toBe('');
  });

  it('summarizeHistory returns hints for frequent groupings', () => {
    const history = Array.from({ length: 5 }, () => ({
      timestamp: Date.now(),
      groups: [{ name: 'Dev', domains: ['github.com', 'stackoverflow.com'] }],
    }));
    const summary = summarizeHistory(history);
    expect(summary).toContain('github.com');
    expect(summary).toContain('Dev');
    expect(summary).toContain('5x');
  });

  it('summarizeHistory ignores infrequent groupings', () => {
    const history = [
      { timestamp: Date.now(), groups: [{ name: 'Random', domains: ['once.com'] }] },
    ];
    const summary = summarizeHistory(history);
    expect(summary).toBe('');
  });
});

// ---------- Export / Import ----------

describe('export/import', () => {
  it('exports all data', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, model: 'custom' });
    const data = await exportAll();
    expect(data.settings.model).toBe('custom');
  });

  it('imports all data', async () => {
    const data: ExportData = {
      settings: { ...DEFAULT_SETTINGS, model: 'imported' },
      affinity: { 'a.com': 'Test' },
      domainRules: [{ domain: 'b.com', groupName: 'B', color: 'green' }],
      workspaces: {},
    };
    await importAll(data);
    expect((await getSettings()).model).toBe('imported');
    expect((await getAffinity())['a.com']).toBe('Test');
  });

  it('imports partial data falling back to defaults', async () => {
    const data = {
      settings: { ...DEFAULT_SETTINGS, model: 'partial' },
    } as ExportData;
    await importAll(data);
    expect((await getSettings()).model).toBe('partial');
    expect(await getAffinity()).toEqual({});
    expect(await getDomainRules()).toEqual([]);
    expect(await getWorkspaces()).toEqual({});
  });

  it('roundtrip preserves data', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'secret', provider: 'groq' });
    await saveDomainRules([{ domain: 'test.com', groupName: 'T', color: 'orange' }]);
    const exported = await exportAll();
    await resetStores();
    await importAll(exported);
    expect((await getSettings()).provider).toBe('groq');
    expect((await getDomainRules())[0].domain).toBe('test.com');
  });
});

describe('workspaces', () => {
  it('returns empty object by default', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ workspaces: {} });
    const ws = await getWorkspaces();
    expect(ws).toEqual({});
  });

  it('saves and retrieves workspace', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ workspaces: {} });
    const wsData = { name: 'Dev', savedAt: 123, tabs: [] };
    await saveWorkspace('Dev', wsData);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ workspaces: { Dev: wsData } });
  });

  it('removes workspace', async () => {
    const wsData = { name: 'Dev', savedAt: 123, tabs: [] };
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ workspaces: { Dev: wsData } });
    await removeWorkspace('Dev');
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ workspaces: {} });
  });
});
