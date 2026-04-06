/**
 * Edge-case tests for storage, background, grouper utilities.
 * Covers boundary conditions, malformed inputs, and unusual browser states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetAllMocks } from './setup';
import {
  isTabUrlAllowed,
  hostnameFromUrl,
  isGroupedTab,
  isImportantAppUrl,
  calculateCost,
  getTabs,
  organize,
  applyGroups,
  saveCurrentWorkspace,
  restoreWorkspaceByName,
} from '../src/background';
import {
  extractPathKey,
  computeDecayedWeight,
  pickBestWeightedGroup,
  getWorkspaces,
  saveWorkspace,
  removeWorkspace,
  getSettings,
} from '../src/storage';
import { DEFAULT_SETTINGS } from '../src/types';
import type { GroupSuggestion, WeightedAffinityEntry, RejectionEntry } from '../src/types';

beforeEach(() => {
  resetAllMocks();
});

// ─── isTabUrlAllowed edge cases ───────────────────────────────────────────────

describe('isTabUrlAllowed – edge cases', () => {
  it('blocks about:newtab', () => expect(isTabUrlAllowed('about:newtab')).toBe(false));
  it('blocks chrome-extension with path', () => expect(isTabUrlAllowed('chrome-extension://abc123/popup.html')).toBe(false));
  it('allows ftp:// URLs', () => expect(isTabUrlAllowed('ftp://files.example.com')).toBe(true));
  it('blocks data: URLs for privacy', () => expect(isTabUrlAllowed('data:text/html,hello')).toBe(false));
  it('handles very long URLs', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000);
    expect(isTabUrlAllowed(longUrl)).toBe(true);
  });
  it('handles URL with unicode characters', () => expect(isTabUrlAllowed('https://münchen.de/path')).toBe(true));
  it('handles edge://settings', () => expect(isTabUrlAllowed('edge://settings')).toBe(false));
  it('blocks about:blank explicitly', () => expect(isTabUrlAllowed('about:blank')).toBe(false));
});

// ─── hostnameFromUrl edge cases ───────────────────────────────────────────────

describe('hostnameFromUrl – edge cases', () => {
  it('handles localhost', () => expect(hostnameFromUrl('http://localhost:3000/app')).toBe('localhost'));
  it('strips only leading www', () => expect(hostnameFromUrl('https://wwwexample.com')).toBe('wwwexample.com'));
  it('handles IPv4 addresses', () => expect(hostnameFromUrl('http://192.168.1.1/admin')).toBe('192.168.1.1'));
  it('handles URL with auth info', () => expect(hostnameFromUrl('https://user:pass@example.com/path')).toBe('example.com'));
  it('handles deep subdomains', () => expect(hostnameFromUrl('https://a.b.c.d.example.com')).toBe('a.b.c.d.example.com'));
  it('handles www.www prefix', () => expect(hostnameFromUrl('https://www.www.example.com')).toBe('www.example.com'));
  it('returns "newtab" for chrome://newtab (URL parses the "host")', () => expect(hostnameFromUrl('chrome://newtab')).toBe('newtab'));
  it('handles URL with fragment', () => expect(hostnameFromUrl('https://example.com/page#section')).toBe('example.com'));
  it('handles URL with query string', () => expect(hostnameFromUrl('https://example.com/search?q=test')).toBe('example.com'));
  it('handles port in URL correctly', () => expect(hostnameFromUrl('https://api.example.com:8443/v1')).toBe('api.example.com'));
});

// ─── isGroupedTab edge cases ──────────────────────────────────────────────────

describe('isGroupedTab – edge cases', () => {
  it('handles groupId = NaN', () => expect(isGroupedTab({ groupId: NaN })).toBe(true)); // NaN !== -1 and !== undefined
  it('handles groupId = Infinity', () => expect(isGroupedTab({ groupId: Infinity })).toBe(true));
  it('handles tab with extra properties', () => expect(isGroupedTab({ groupId: 5, id: 1, title: 'test' })).toBe(true));
  it('handles empty object', () => expect(isGroupedTab({})).toBe(false));
  it('handles groupId = 1 (first real group)', () => expect(isGroupedTab({ groupId: 1 })).toBe(true));
});

// ─── calculateCost edge cases ─────────────────────────────────────────────────

describe('calculateCost – edge cases', () => {
  it('handles very large token counts', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000_000, 0);
    expect(cost).toBeCloseTo(3000, 0);
  });
  it('handles fractional token counts', () => {
    const cost = calculateCost('gpt-4.1', 0.5, 0.5);
    expect(cost).toBeGreaterThan(0);
  });
  it('handles negative token counts', () => {
    const cost = calculateCost('claude-haiku-4-5', -100, -100);
    expect(cost).toBeLessThan(0); // negative input = negative cost (no special handling)
  });
  it('returns 0 for openrouter/free model', () => {
    expect(calculateCost('openrouter/free', 100_000, 100_000)).toBe(0);
  });
});

// ─── extractPathKey edge cases ────────────────────────────────────────────────

describe('extractPathKey – edge cases', () => {
  it('returns null for non-multi-tenant domains', () => {
    expect(extractPathKey('https://example.com/user/profile')).toBeNull();
  });
  it('returns path key for github.com', () => {
    expect(extractPathKey('https://github.com/anthropics/claude')).toBe('github.com/anthropics');
  });
  it('returns null for github.com root', () => {
    expect(extractPathKey('https://github.com/')).toBeNull();
  });
  it('handles youtube.com with watch path', () => {
    expect(extractPathKey('https://youtube.com/watch?v=abc')).toBe('youtube.com/watch');
  });
  it('handles www prefix for multi-tenant', () => {
    expect(extractPathKey('https://www.github.com/user/repo')).toBe('github.com/user');
  });
  it('returns null for invalid URL', () => {
    expect(extractPathKey('not-a-url')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(extractPathKey('')).toBeNull();
  });
});

// ─── computeDecayedWeight edge cases ─────────────────────────────────────────

describe('computeDecayedWeight – edge cases', () => {
  it('returns 0 for count = 0', () => {
    expect(computeDecayedWeight(0, Date.now())).toBe(0);
  });
  it('returns count when lastUsed = now (no decay)', () => {
    const now = Date.now();
    const weight = computeDecayedWeight(10, now, now);
    expect(weight).toBeCloseTo(10, 3);
  });
  it('decays over time', () => {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const weight = computeDecayedWeight(10, oneWeekAgo, now);
    expect(weight).toBeLessThan(10);
    expect(weight).toBeGreaterThan(0);
  });
  it('handles very old timestamps', () => {
    const weight = computeDecayedWeight(100, 0);
    expect(weight).toBeGreaterThanOrEqual(0);
  });
  it('handles future lastUsed', () => {
    const now = Date.now();
    const future = now + 1000000;
    const weight = computeDecayedWeight(5, future, now);
    // exp of positive = > 1, so weight > 5
    expect(weight).toBeGreaterThan(5);
  });
});

// ─── pickBestWeightedGroup edge cases ─────────────────────────────────────────

describe('pickBestWeightedGroup – edge cases', () => {
  it('returns null when all groups are rejected', () => {
    const now = Date.now();
    const entry: WeightedAffinityEntry = {
      groups: { 'Dev': { count: 10, lastUsed: now } },
    };
    const rejections: RejectionEntry[] = [
      { timestamp: now, domain: 'github.com', rejectedGroup: 'Dev' },
    ];
    expect(pickBestWeightedGroup(entry, rejections, 'github.com', now)).toBeNull();
  });

  it('returns null when all weights are below threshold', () => {
    const entry: WeightedAffinityEntry = {
      groups: { 'Dev': { count: 0, lastUsed: 0 } },
    };
    expect(pickBestWeightedGroup(entry, [], 'example.com')).toBeNull();
  });

  it('picks the group with highest weight', () => {
    const now = Date.now();
    const entry: WeightedAffinityEntry = {
      groups: {
        'Dev': { count: 10, lastUsed: now },
        'Research': { count: 1, lastUsed: now },
      },
    };
    expect(pickBestWeightedGroup(entry, [], 'github.com', now)).toBe('Dev');
  });

  it('ignores expired rejections', () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const entry: WeightedAffinityEntry = {
      groups: { 'Dev': { count: 10, lastUsed: now } },
    };
    const rejections: RejectionEntry[] = [
      { timestamp: thirtyOneDaysAgo, domain: 'github.com', rejectedGroup: 'Dev' },
    ];
    // Expired rejection should be ignored
    const result = pickBestWeightedGroup(entry, rejections, 'github.com', now);
    expect(result).toBe('Dev');
  });

  it('returns null for empty groups', () => {
    const entry: WeightedAffinityEntry = { groups: {} };
    expect(pickBestWeightedGroup(entry, [], 'example.com')).toBeNull();
  });
});

// ─── Workspace storage edge cases ─────────────────────────────────────────────

describe('workspace storage – edge cases', () => {
  it('getWorkspaces returns empty map when nothing saved', async () => {
    const ws = await getWorkspaces();
    expect(ws).toEqual({});
  });

  it('saveWorkspace and retrieve', async () => {
    await saveWorkspace('test', {
      name: 'test',
      savedAt: 123456,
      tabs: [{ url: 'https://example.com', title: 'Test', pinned: false, active: true }],
    });
    const ws = await getWorkspaces();
    expect(ws['test']).toBeDefined();
    expect(ws['test'].tabs).toHaveLength(1);
  });

  it('saveWorkspace overwrites existing workspace with same name', async () => {
    await saveWorkspace('ws1', { name: 'ws1', savedAt: 1, tabs: [] });
    await saveWorkspace('ws1', { name: 'ws1', savedAt: 2, tabs: [{ url: 'https://x.com', title: 'X', pinned: false, active: false }] });
    const ws = await getWorkspaces();
    expect(ws['ws1'].savedAt).toBe(2);
    expect(ws['ws1'].tabs).toHaveLength(1);
  });

  it('removeWorkspace deletes the named workspace', async () => {
    await saveWorkspace('deleteme', { name: 'deleteme', savedAt: 1, tabs: [] });
    await removeWorkspace('deleteme');
    const ws = await getWorkspaces();
    expect(ws['deleteme']).toBeUndefined();
  });

  it('removeWorkspace is no-op when name does not exist', async () => {
    await expect(removeWorkspace('nonexistent')).resolves.not.toThrow();
  });

  it('can save multiple workspaces', async () => {
    await saveWorkspace('ws1', { name: 'ws1', savedAt: 1, tabs: [] });
    await saveWorkspace('ws2', { name: 'ws2', savedAt: 2, tabs: [] });
    await saveWorkspace('ws3', { name: 'ws3', savedAt: 3, tabs: [] });
    const ws = await getWorkspaces();
    expect(Object.keys(ws)).toHaveLength(3);
  });
});

// ─── saveCurrentWorkspace edge cases ─────────────────────────────────────────

describe('saveCurrentWorkspace', () => {
  beforeEach(() => {
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 1 } as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GitHub', pinned: false, active: true, groupId: -1 },
      { id: 2, url: 'https://youtube.com', title: 'YouTube', pinned: false, active: false, groupId: -1 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);
  });

  it('saves current window tabs as a workspace', async () => {
    await saveCurrentWorkspace('myws');
    const ws = await getWorkspaces();
    expect(ws['myws']).toBeDefined();
    expect(ws['myws'].tabs.length).toBeGreaterThan(0);
  });

  it('excludes chrome:// tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'chrome://newtab', title: 'New Tab', pinned: false, active: true, groupId: -1 },
      { id: 2, url: 'https://github.com', title: 'GitHub', pinned: false, active: false, groupId: -1 },
    ] as any);
    await saveCurrentWorkspace('filtered');
    const ws = await getWorkspaces();
    expect(ws['filtered'].tabs.every(t => !t.url.startsWith('chrome://'))).toBe(true);
  });

  it('saves group info for grouped tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 10, url: 'https://github.com', title: 'GH', pinned: false, active: true, groupId: 42 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 42, title: 'Dev', color: 'blue', windowId: 1 },
    ] as any);
    await saveCurrentWorkspace('grouped');
    const ws = await getWorkspaces();
    const tab = ws['grouped'].tabs[0];
    expect(tab.groupName).toBe('Dev');
    expect(tab.groupColor).toBe('blue');
  });

  it('throws when window id is undefined', async () => {
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({} as any);
    vi.mocked(chrome.windows.getLastFocused).mockResolvedValue({} as any);
    await expect(saveCurrentWorkspace('fail')).rejects.toThrow('Could not determine current window');
  });
});

// ─── restoreWorkspaceByName edge cases ───────────────────────────────────────

describe('restoreWorkspaceByName', () => {
  it('throws when workspace not found', async () => {
    await expect(restoreWorkspaceByName('nonexistent')).rejects.toThrow('not found');
  });

  it('opens a new window and creates tabs', async () => {
    await saveWorkspace('myws', {
      name: 'myws',
      savedAt: Date.now(),
      tabs: [
        { url: 'https://github.com', title: 'GH', pinned: false, active: true },
        { url: 'https://docs.com', title: 'Docs', pinned: false, active: false },
      ],
    });

    vi.mocked(chrome.windows.create).mockResolvedValue({ id: 99 } as any);
    vi.mocked(chrome.tabs.create).mockImplementation(async (props: any) => ({
      id: Math.floor(Math.random() * 1000),
      url: props.url,
      windowId: 99,
      groupId: -1,
      title: '',
      active: props.active ?? false,
      pinned: props.pinned ?? false,
      index: 0,
    }) as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);

    await restoreWorkspaceByName('myws');

    expect(chrome.windows.create).toHaveBeenCalledWith({ focused: true });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('throws when window create returns undefined', async () => {
    await saveWorkspace('ws', { name: 'ws', savedAt: 1, tabs: [{ url: 'https://x.com', title: 'X', pinned: false, active: false }] });
    vi.mocked(chrome.windows.create).mockResolvedValue(undefined as any);
    await expect(restoreWorkspaceByName('ws')).rejects.toThrow('Could not create window');
  });

  it('recreates tab groups from saved workspace', async () => {
    await saveWorkspace('grouped', {
      name: 'grouped',
      savedAt: Date.now(),
      tabs: [
        { url: 'https://github.com', title: 'GH', pinned: false, active: true, groupName: 'Dev', groupColor: 'blue' },
        { url: 'https://npmjs.com', title: 'npm', pinned: false, active: false, groupName: 'Dev', groupColor: 'blue' },
      ],
    });

    let tabIdCounter = 200;
    vi.mocked(chrome.windows.create).mockResolvedValue({ id: 99 } as any);
    vi.mocked(chrome.tabs.create).mockImplementation(async () => ({
      id: tabIdCounter++,
      windowId: 99,
      url: '',
      groupId: -1,
      title: '',
      active: false,
      pinned: false,
      index: 0,
    }) as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);

    await restoreWorkspaceByName('grouped');

    expect(chrome.tabs.group).toHaveBeenCalledTimes(1);
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ title: 'Dev', color: 'blue' }),
    );
  });
});

// ─── getTabs edge cases ───────────────────────────────────────────────────────

describe('getTabs – edge cases', () => {
  it('returns empty array when all tabs are chrome://', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'chrome://newtab', title: 'NTP', groupId: -1 },
      { id: 2, url: 'chrome://extensions', title: 'Ext', groupId: -1 },
    ] as any);
    const tabs = await getTabs();
    expect(tabs).toHaveLength(0);
  });

  it('handles tab with missing title gracefully', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 5, url: 'https://example.com', title: undefined, groupId: -1 },
    ] as any);
    const tabs = await getTabs();
    expect(tabs[0].title).toBe('');
  });

  it('handles large number of tabs', async () => {
    const manyTabs = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      url: `https://site${i}.com`,
      title: `Site ${i}`,
      groupId: -1,
    }));
    vi.mocked(chrome.tabs.query).mockResolvedValue(manyTabs as any);
    const tabs = await getTabs();
    expect(tabs).toHaveLength(200);
  });
});

// ─── organize edge cases ──────────────────────────────────────────────────────

describe('organize – edge cases', () => {
  beforeEach(async () => {
    const { saveSettings } = await import('../src/storage');
    await saveSettings({ ...DEFAULT_SETTINGS, provider: 'openai', apiKey: 'test', baseUrl: 'https://api.test.com/v1', model: 'test' });
  });

  it('returns error for exactly 1 tab', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://example.com', title: 'Solo', groupId: -1 },
    ] as any);
    const result = await organize();
    expect(result.error).toBeDefined();
  });

  it('returns error for 0 tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    const result = await organize();
    expect(result.error).toBeDefined();
  });

  it('handles LLM returning malformed JSON gracefully', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', groupId: -1 },
      { id: 2, url: 'https://docs.com', title: 'Docs', groupId: -1 },
    ] as any);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'not valid json [[' } }],
    })));
    const result = await organize();
    // Should fail gracefully
    expect(result.error).toBeDefined();
  });
});

// ─── applyGroups edge cases ───────────────────────────────────────────────────

describe('applyGroups – edge cases', () => {
  it('handles all-empty suggestions array', async () => {
    await expect(applyGroups([])).resolves.not.toThrow();
    expect(chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('handles suggestion with only chrome:// tabs (filtered)', async () => {
    const suggestions: GroupSuggestion[] = [
      { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'NTP', url: 'chrome://newtab' }] },
    ];
    // tabs.ungroup with empty array should still be called if allTabIds is non-empty
    // but chrome:// tabs have id 1 here - ungroup would be called
    await expect(applyGroups(suggestions)).resolves.not.toThrow();
  });

  it('uses color preferences over suggestion color', async () => {
    // Pre-save a color preference
    const { saveGroupColorPref } = await import('../src/storage');
    await saveGroupColorPref('Dev', 'purple');

    let groupIdCtr = 300;
    vi.mocked(chrome.tabs.group).mockImplementation(async () => groupIdCtr++);

    const suggestions: GroupSuggestion[] = [
      { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com' }] },
    ];
    await applyGroups(suggestions);
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(
      300,
      expect.objectContaining({ color: 'purple' }),
    );
  });

  it('skips pinned group suggestions', async () => {
    const { saveSettings } = await import('../src/storage');
    await saveSettings({ ...DEFAULT_SETTINGS, pinnedGroups: ['Pinned'] });

    const suggestions: GroupSuggestion[] = [
      { name: 'Pinned', color: 'blue', tabs: [{ id: 1, title: 'P', url: 'https://pinned.com' }] },
      { name: 'Normal', color: 'red', tabs: [{ id: 2, title: 'N', url: 'https://normal.com' }] },
    ];
    await applyGroups(suggestions);
    // Only 'Normal' should create a group
    expect(chrome.tabs.group).toHaveBeenCalledTimes(1);
  });
});
