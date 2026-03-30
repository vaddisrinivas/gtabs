import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetAllMocks } from './setup';
import { getSuggestions, saveSettings, saveSuggestions, saveUndoSnapshot } from '../src/storage';
import { DEFAULT_SETTINGS } from '../src/types';
import type { TabInfo, GroupSuggestion } from '../src/types';

// We test background logic via exported functions
// Background registers listeners — we'll import the module functions directly
import {
  autoPinImportantApps,
  consolidateWindows,
  deleteAllTabGroups,
  focusCurrentGroup,
  getTabs, organize, applyGroups, findDuplicateTabs,
  purgeStaleTabs,
  sortCurrentGroupsByDomain,
  snapshotCurrentState, restoreSnapshot, undoLastGrouping
} from '../src/background';

const chromeTabs = [
  { id: 1, title: 'GitHub', url: 'https://github.com/repo', groupId: -1 },
  { id: 2, title: 'YouTube', url: 'https://youtube.com/watch', groupId: -1 },
  { id: 3, title: 'Gmail', url: 'https://mail.google.com/inbox', groupId: -1 },
  { id: undefined, title: 'No ID', url: 'https://noid.com' },
  { id: 4, title: 'Extensions', url: 'chrome://extensions' },
  { id: 5, title: 'New Tab', url: 'chrome://newtab' },
];

function mockFetchLLM(content: string) {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content } }],
  })));
}

beforeEach(() => {
  resetAllMocks();
  vi.mocked(chrome.tabs.query).mockResolvedValue(chromeTabs as any);
});

// ---------- getTabs ----------

describe('getTabs', () => {
  it('filters out chrome:// URLs', async () => {
    const tabs = await getTabs();
    expect(tabs.every(t => !t.url.startsWith('chrome://'))).toBe(true);
  });

  it('filters out tabs without IDs', async () => {
    const tabs = await getTabs();
    expect(tabs.every(t => typeof t.id === 'number')).toBe(true);
  });

  it('returns correct tab info shape', async () => {
    const tabs = await getTabs();
    for (const t of tabs) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('title');
      expect(t).toHaveProperty('url');
    }
  });

  it('queries current window', async () => {
    await getTabs();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ currentWindow: true });
  });

  it('handles empty tab list', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    const tabs = await getTabs();
    expect(tabs).toEqual([]);
  });

  it('handles tabs with empty title', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: '', url: 'https://example.com' } as any,
    ]);
    const tabs = await getTabs();
    expect(tabs[0].title).toBe('');
  });
});

// ---------- organize ----------

const TEST_SETTINGS = { ...DEFAULT_SETTINGS, provider: 'openai', baseUrl: 'https://api.test.com/v1', apiKey: 'test', model: 'test-model' };

describe('organize', () => {
  beforeEach(async () => {
    await saveSettings(TEST_SETTINGS);
  });

  it('returns error when fewer than 2 tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'Solo', url: 'https://example.com' } as any,
    ]);
    const result = await organize();
    expect(result.error).toContain('at least 2');
  });

  it('returns suggestions on success', async () => {
    mockFetchLLM('[{"name":"Dev","color":"blue","tabIds":[1]},{"name":"Fun","color":"red","tabIds":[2]}]');
    const result = await organize();
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions!.length).toBeGreaterThan(0);
  });

  it('sets badge text to group count', async () => {
    mockFetchLLM('[{"name":"Dev","color":"blue","tabIds":[1]}]');
    await organize();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
  });

  it('returns error on LLM failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network down'));
    const result = await organize();
    expect(result.error).toContain('Network down');
  });

  it('catches non-Error exceptions', async () => {
    vi.mocked(fetch).mockRejectedValue('string error');
    const result = await organize();
    expect(result.error).toBe('Unknown error');
  });
});

// ---------- applyGroups ----------

describe('applyGroups', () => {
  const suggestions: GroupSuggestion[] = [
    { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com' }] },
    { name: 'Media', color: 'red', tabs: [
      { id: 2, title: 'YT', url: 'https://youtube.com' },
      { id: 3, title: 'Gmail', url: 'https://mail.google.com' },
    ]},
  ];

  it('ungroups all tabs first', async () => {
    await applyGroups(suggestions);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('creates groups for each suggestion', async () => {
    await applyGroups(suggestions);
    expect(chrome.tabs.group).toHaveBeenCalledTimes(2);
  });

  it('sets correct group titles and colors', async () => {
    let callCount = 0;
    vi.mocked(chrome.tabs.group).mockImplementation(async () => 200 + callCount++);
    await applyGroups(suggestions);
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(200, expect.objectContaining({ title: 'Dev', color: 'blue' }));
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(201, expect.objectContaining({ title: 'Media', color: 'red' }));
  });

  it('skips empty groups', async () => {
    const withEmpty: GroupSuggestion[] = [
      { name: 'Empty', color: 'grey', tabs: [] },
      { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com' }] },
    ];
    await applyGroups(withEmpty);
    expect(chrome.tabs.group).toHaveBeenCalledTimes(1);
  });

  it('clears badge after applying', async () => {
    await applyGroups(suggestions);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('handles ungroup failure gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(chrome.tabs.ungroup).mockRejectedValue(new Error('tabs not grouped'));
    await expect(applyGroups(suggestions)).resolves.not.toThrow();
    consoleSpy.mockRestore();
  });

  it('updates affinity from applied groups', async () => {
    await applyGroups(suggestions);
    // Affinity is updated — verify storage was written
    const affinityData = await chrome.storage.local.get({ affinity: {} });
    const affinity = affinityData.affinity as Record<string, string>;
    expect(affinity['github.com']).toBe('Dev');
  });
});

// ---------- findDuplicateTabs ----------

describe('findDuplicateTabs', () => {
  it('finds duplicate tabs from current window', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'A', url: 'https://example.com' },
      { id: 2, title: 'A copy', url: 'https://example.com' },
      { id: 3, title: 'B', url: 'https://other.com' },
    ] as any);
    const dupes = await findDuplicateTabs();
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toHaveLength(2);
  });

  it('returns empty when no duplicates', async () => {
    const dupes = await findDuplicateTabs();
    expect(dupes).toHaveLength(0);
  });
});

// ---------- snapshot / restore ----------

describe('undo snapshot', () => {
  it('takes snapshot of current tab grouping state', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'A', url: 'https://a.com', groupId: 100 },
      { id: 2, title: 'B', url: 'https://b.com', groupId: -1 },
    ] as any);

    const snapshot = await snapshotCurrentState();
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toEqual({ tabId: 1, groupId: 100 });
    expect(snapshot.ungrouped).toEqual([2]);
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });

  it('keeps groupId 0 in the undo snapshot', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'Pinned Group', url: 'https://a.com', groupId: 0 },
      { id: 2, title: 'Loose', url: 'https://b.com', groupId: -1 },
    ] as any);

    const snapshot = await snapshotCurrentState();

    expect(snapshot.groups).toEqual([{ tabId: 1, groupId: 0 }]);
    expect(snapshot.ungrouped).toEqual([2]);
  });

  it('restores tabs to previous grouping', async () => {
    const snapshot = {
      timestamp: Date.now(),
      groups: [{ tabId: 1, groupId: 100 }, { tabId: 2, groupId: 100 }],
      ungrouped: [3],
    };

    await restoreSnapshot(snapshot);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([3]);
    expect(chrome.tabs.group).toHaveBeenCalled();
  });

  it('handles snapshot with only ungrouped tabs', async () => {
    const snapshot = { timestamp: Date.now(), groups: [], ungrouped: [1, 2, 3] };
    await restoreSnapshot(snapshot);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1, 2, 3]);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('handles restore failure gracefully', async () => {
    const snapshot = { timestamp: Date.now(), groups: [], ungrouped: [1] };
    await saveUndoSnapshot(snapshot);
    vi.mocked(chrome.tabs.query).mockRejectedValue(new Error('no tab'));
    const result = await undoLastGrouping();
    expect(result.error).toBe('no tab');
  });
});

// ---------- power tools ----------

describe('power tools', () => {
  beforeEach(async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, ...TEST_SETTINGS, autoPinApps: false, staleTabThresholdHours: 24 });
  });

  it('consolidates tabs from other windows into the current one', async () => {
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 1 } as any);
    vi.mocked(chrome.windows.getAll).mockResolvedValue([
      { id: 1, tabs: [{ id: 1, url: 'https://here.com' }] },
      { id: 2, tabs: [{ id: 21, url: 'https://one.com' }, { id: 22, url: 'chrome://extensions' }] },
      { id: 3, tabs: [{ id: 31, url: 'https://two.com' }] },
    ] as any);

    const count = await consolidateWindows();

    expect(count).toBe(2);
    expect(chrome.tabs.move).toHaveBeenCalledWith([21], { windowId: 1, index: -1 });
    expect(chrome.tabs.move).toHaveBeenCalledWith([31], { windowId: 1, index: -1 });
  });


  it('purges tabs older than the stale threshold', async () => {
    const now = Date.now();
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'Active', url: 'https://active.com', active: true, pinned: false, lastAccessed: now - 1000, groupId: -1 },
      { id: 2, title: 'Old', url: 'https://old.com', active: false, pinned: false, lastAccessed: now - (30 * 60 * 60 * 1000), groupId: -1 },
      { id: 3, title: 'Pinned', url: 'https://pinned.com', active: false, pinned: true, lastAccessed: now - (30 * 60 * 60 * 1000), groupId: -1 },
    ] as any);

    const count = await purgeStaleTabs();

    expect(count).toBe(1);
    expect(chrome.tabs.remove).toHaveBeenCalledWith([2]);
  });

  it('focuses the active group by collapsing the others', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (query: any) => {
      if (query?.active) {
        return [{ id: 1, windowId: 1, groupId: 99 }] as any;
      }
      return [] as any;
    });
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 99, title: 'Current' },
      { id: 100, title: 'Other' },
    ] as any);

    const count = await focusCurrentGroup();

    expect(count).toBe(2);
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(99, { collapsed: false });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, { collapsed: true });
  });

  it('focuses groupId 0 correctly', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (query: any) => {
      if (query?.active) {
        return [{ id: 1, windowId: 1, groupId: 0 }] as any;
      }
      return [] as any;
    });
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 0, title: 'Current' },
      { id: 2, title: 'Other' },
    ] as any);

    const count = await focusCurrentGroup();

    expect(count).toBe(2);
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(0, { collapsed: false });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(2, { collapsed: true });
  });


  it('sorts grouped tabs by domain and title', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'Zed', url: 'https://z.com', groupId: 10, index: 0 },
      { id: 2, title: 'Alpha', url: 'https://a.com', groupId: 10, index: 1 },
      { id: 3, title: 'Docs', url: 'https://docs.google.com', groupId: -1, index: 2, pinned: false },
    ] as any);
    await saveSettings({ ...DEFAULT_SETTINGS, ...TEST_SETTINGS, autoPinApps: true });

    const count = await sortCurrentGroupsByDomain();

    expect(count).toBe(2);
    expect(chrome.tabs.move).toHaveBeenCalledWith(2, { index: 0 });
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { pinned: true });
  });

  it('pins important app tabs when enabled', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, ...TEST_SETTINGS, autoPinApps: true });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox', groupId: -1, pinned: false, index: 1 },
      { id: 2, title: 'News', url: 'https://news.ycombinator.com', groupId: -1, pinned: false, index: 2 },
    ] as any);

    const count = await autoPinImportantApps();

    expect(count).toBe(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { pinned: true });
  });

  it('deletes all groups in current window and returns cleared group count', async () => {
    await saveSuggestions([{ name: 'Old', color: 'grey', tabs: [{ id: 1, title: 'A', url: 'https://a.com' }] }]);
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'A', url: 'https://a.com', groupId: 11 },
      { id: 2, title: 'B', url: 'https://b.com', groupId: 11 },
      { id: 3, title: 'C', url: 'https://c.com', groupId: 12 },
      { id: 4, title: 'D', url: 'https://d.com', groupId: -1 },
    ] as any);

    const count = await deleteAllTabGroups();

    expect(count).toBe(2);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1, 2, 3]);
    expect(await getSuggestions()).toBeNull();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('deletes grouped tabs with groupId 0 correctly', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'A', url: 'https://a.com', groupId: 0 },
      { id: 2, title: 'B', url: 'https://b.com', groupId: -1 },
    ] as any);

    const count = await deleteAllTabGroups();

    expect(count).toBe(1);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1]);
  });

});

// ---------- Event Listeners ----------

describe('event listeners', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    await saveSettings({ ...DEFAULT_SETTINGS, autoTrigger: true, threshold: 0, silentAutoAdd: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles alarm for auto trigger', async () => {
    const origQuery = vi.mocked(chrome.tabs.query);
    origQuery.mockResolvedValue([
      { id: 1, url: 'https://a.com', groupId: -1 },
      { id: 2, url: 'https://b.com', groupId: -1 },
    ] as any);
    mockFetchLLM('[]'); // dummy answer

    // Trigger the alarm
    await (chrome.alarms.onAlarm as any).callListeners({ name: 'gtabs-check' });
    await vi.runAllTimersAsync();
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));
    
    // Check if organize logic kicked in. fetch is a good proxy.
    expect(fetch).toHaveBeenCalled();
  });

  it('auto-trigger applies grouped suggestions when threshold is met', async () => {
    const origQuery = vi.mocked(chrome.tabs.query);
    origQuery.mockResolvedValue([
      { id: 1, title: 'A', url: 'https://a.com', groupId: -1 },
      { id: 2, title: 'B', url: 'https://b.com', groupId: -1 },
    ] as any);
    mockFetchLLM('[{"name":"Auto Group","color":"blue","tabIds":[1,2]}]');

    await (chrome.alarms.onAlarm as any).callListeners({ name: 'gtabs-check' });
    await vi.runAllTimersAsync();
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));

    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
  });

  it('debounces tab changes for auto trigger', async () => {
    const origQuery = vi.mocked(chrome.tabs.query);
    origQuery.mockResolvedValue([
      { id: 1, url: 'https://a.com', groupId: -1 },
      { id: 2, url: 'https://b.com', groupId: -1 },
    ] as any);
    mockFetchLLM('[]');

    await (chrome.tabs.onCreated as any).callListeners();
    await (chrome.tabs.onRemoved as any).callListeners();
    
    // We called it twice, but it should debounce to 1 organize call
    await vi.runAllTimersAsync();
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('silently auto adds tabs on update if configured', async () => {
    // We set silentAutoAdd to true in beforeEach.
    // Need to mock getDomainRules and getAffinity indirectly via storage
    await saveSettings({ ...DEFAULT_SETTINGS, silentAutoAdd: true });
    await chrome.storage.local.set({ affinity: { 'github.com': 'Dev' } });

    // Mock that we don't have exactly the group open yet
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);
    vi.mocked(chrome.tabs.group).mockResolvedValue(100);

    const tab = { url: 'https://github.com/repo', windowId: 1, groupId: -1 };
    await (chrome.tabs.onUpdated as any).callListeners(1, { status: 'complete' }, tab);

    // Should create new group and update title
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1] });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, expect.objectContaining({ title: 'Dev' }));
  });

  it('adds tab to existing group on update', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, silentAutoAdd: true });
    await chrome.storage.local.set({ affinity: { 'youtube.com': 'Media' } });

    // Mock existing group
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([{ id: 50, title: 'Media' }] as any);

    const tab = { url: 'https://youtube.com', windowId: 1, groupId: -1 };
    await (chrome.tabs.onUpdated as any).callListeners(2, { status: 'complete' }, tab);

    // Should just group
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [2], groupId: 50 });
  });

  it('bails early on silent auto add if irrelevant tab', async () => {
    const tab = { url: 'chrome://newtab', windowId: 1, groupId: -1 };
    await (chrome.tabs.onUpdated as any).callListeners(3, { status: 'complete' }, tab);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
  });

  it('checks auto-trigger on tab update even when silent auto add is off', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, ...TEST_SETTINGS, autoTrigger: true, threshold: 0, silentAutoAdd: false });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, title: 'A', url: 'https://a.com', groupId: -1 },
      { id: 2, title: 'B', url: 'https://b.com', groupId: -1 },
    ] as any);
    mockFetchLLM('[]');

    await (chrome.tabs.onUpdated as any).callListeners(1, { status: 'complete' }, { url: 'https://a.com', windowId: 1, groupId: -1 });
    for (let i = 0; i < 20; i++) await new Promise(r => process.nextTick(r));

    expect(fetch).toHaveBeenCalled();
  });

  it('handles grouping failure gracefully on silent auto add', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, silentAutoAdd: true });
    await chrome.storage.local.set({ affinity: { 'github.com': 'Dev' } });
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);
    vi.mocked(chrome.tabs.group).mockRejectedValue(new Error('fail'));

    const tab = { url: 'https://github.com/repo', windowId: 1, groupId: -1 };
    await expect((chrome.tabs.onUpdated as any).callListeners(1, { status: 'complete' }, tab)).resolves.not.toThrow();
  });

  describe('system events', () => {
    it('handles onInstalled', async () => {
      await (chrome.runtime.onInstalled as any).callListeners();
      expect(chrome.alarms.create).toHaveBeenCalled();
      expect(chrome.contextMenus.create).toHaveBeenCalledTimes(4);
    });

    it('handles commands', async () => {
      await (chrome.commands.onCommand as any).callListeners('organize-tabs');
      await (chrome.commands.onCommand as any).callListeners('undo-grouping');
      expect(chrome.tabs.query).toHaveBeenCalled();
    });

    it('handles context menus', async () => {
      await (chrome.contextMenus.onClicked as any).callListeners({ menuItemId: 'gtabs-organize' });
      await (chrome.contextMenus.onClicked as any).callListeners({ menuItemId: 'gtabs-organize-ungrouped' });
      await (chrome.contextMenus.onClicked as any).callListeners({ menuItemId: 'gtabs-undo' });
      await (chrome.contextMenus.onClicked as any).callListeners({ menuItemId: 'gtabs-duplicates' });
      expect(chrome.tabs.query).toHaveBeenCalled();
    });
  });

  describe('onMessage router', () => {
    it('routes all messages and calls sendResponse', async () => {
      const messages: any[] = [
        { type: 'organize' },
        { type: 'organize-ungrouped' },
        { type: 'apply', suggestions: [] },
        { type: 'undo' },
        { type: 'find-duplicates' },
        { type: 'focus-group' },
        { type: 'sort-groups' },
        { type: 'delete-all-groups' },
        { type: 'get-stats' },
        { type: 'get-costs' },
        { type: 'export-data' },
        { type: 'import-data', data: {} },
        { type: 'test-connection' },
        { type: 'check-chrome-ai' },
        { type: 'fetch-ollama-models' },
      ];

      for (const msg of messages) {
        let responded = false;
        const sendResponse = vi.fn().mockImplementation(() => { responded = true; });
        const isAsync = await (chrome.runtime.onMessage as any).callListeners(msg, {}, sendResponse);
        // We either expect `responded` to be true synchronously or after ticks
        for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));
        if (msg.type === 'check-chrome-ai') {
           expect(isAsync).toEqual([false]); // onMessage returns false for sync
        } else {
           expect(isAsync).toEqual([true]); // onMessage returns true to keep channel open
        }
        expect(sendResponse).toHaveBeenCalled();
      }
    });
  });
});
