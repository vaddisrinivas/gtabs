/**
 * Integration tests: Background message handler end-to-end flows.
 * Tests the full pipeline through message dispatch without DOM dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetAllMocks, resetStores } from './setup';
import { DEFAULT_SETTINGS } from '../src/types';

// Helper: flush microtasks
async function flush(n = 20) {
  for (let i = 0; i < n; i++) await new Promise(r => process.nextTick(r));
}

// Helper: send a message through the background listener
async function sendMsg(msg: any): Promise<any> {
  return new Promise(resolve => {
    (chrome.runtime.onMessage as any).callListeners(msg, {}, resolve);
  });
}

describe('E2E Integration: Message dispatch → Background → Storage', () => {
  beforeEach(async () => {
    resetAllMocks();
    // Clear accumulated message listeners from previous test's background import
    (chrome.runtime.onMessage as any).listeners.clear();
    vi.resetModules();
    // Load background to register message listeners
    await import('../src/background');
    await flush(5);
    // Set up default settings with API key so organize can run
    const { saveSettings } = await import('../src/storage');
    await saveSettings({
      ...DEFAULT_SETTINGS,
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      model: 'gpt-4.1',
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────

  it('get-stats returns initial zero stats', async () => {
    const res = await sendMsg({ type: 'get-stats' });
    expect(res.stats.totalOrganizations).toBe(0);
    expect(res.stats.totalTabsGrouped).toBe(0);
    expect(res.stats.lastOrganizedAt).toBeNull();
  });

  it('stats increment after apply', async () => {
    const { applyGroups } = await import('../src/background');
    await applyGroups([
      { name: 'Dev', color: 'blue', tabs: [{ id: 1, title: 'GH', url: 'https://github.com' }] },
      { name: 'Docs', color: 'green', tabs: [{ id: 2, title: 'Docs', url: 'https://docs.com' }] },
    ]);

    const res = await sendMsg({ type: 'get-stats' });
    expect(res.stats.totalOrganizations).toBe(1);
    expect(res.stats.totalTabsGrouped).toBe(2);
    expect(res.stats.lastOrganizedAt).toBeGreaterThan(0);
  });

  // ─── Costs ─────────────────────────────────────────────────────────────────

  it('get-costs returns initial zero costs', async () => {
    const res = await sendMsg({ type: 'get-costs' });
    expect(res.costs.totalCost).toBe(0);
    expect(res.costs.totalInputTokens).toBe(0);
  });

  it('costs accumulate after organize with LLM usage', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', groupId: -1 },
      { id: 2, url: 'https://docs.com', title: 'Docs', groupId: -1 },
    ] as any);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '[{"name":"Dev","tabIds":[1,2]}]' } }],
      usage: { prompt_tokens: 500, completion_tokens: 200 },
    })));

    const { organize } = await import('../src/background');
    await organize();

    const res = await sendMsg({ type: 'get-costs' });
    expect(res.costs.totalCost).toBeGreaterThan(0);
    expect(res.costs.totalInputTokens).toBe(500);
  });

  // ─── Organize → Apply → Undo pipeline ────────────────────────────────────

  it('organize then apply updates affinity', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', groupId: -1 },
      { id: 2, url: 'https://youtube.com', title: 'YT', groupId: -1 },
    ] as any);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '[{"name":"Dev","tabIds":[1]},{"name":"Fun","tabIds":[2]}]' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }), { status: 200 }));

    const organizeRes = await sendMsg({ type: 'organize' });
    expect(organizeRes.suggestions).toBeDefined();
    expect(organizeRes.suggestions.length).toBeGreaterThan(0);

    const applyRes = await sendMsg({ type: 'apply', suggestions: organizeRes.suggestions });
    expect(applyRes.status).toBe('applied');

    // Check affinity was updated
    const { getWeightedAffinity } = await import('../src/storage');
    const affinity = await getWeightedAffinity();
    expect(Object.keys(affinity).length).toBeGreaterThan(0);
  });

  it('undo after apply restores state', async () => {
    // Apply groups first
    vi.mocked(chrome.tabs.group).mockImplementation(async () => 100);
    await sendMsg({
      type: 'apply',
      suggestions: [
        { name: 'Dev', color: 'blue', tabs: [{ id: 5, title: 'GH', url: 'https://github.com' }] },
      ],
    });

    // Undo
    const undoRes = await sendMsg({ type: 'undo' });
    expect(undoRes.status).toBe('undone');
    expect(undoRes.error).toBeUndefined();
  });

  it('undo returns error when no snapshot exists', async () => {
    const res = await sendMsg({ type: 'undo' });
    expect(res.error).toBeDefined();
    expect(res.error).toContain('No undo history');
  });

  // ─── Find Duplicates ──────────────────────────────────────────────────────

  it('find-duplicates returns groups of duplicate URLs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://example.com', title: 'A', groupId: -1 },
      { id: 2, url: 'https://example.com', title: 'B', groupId: -1 },
      { id: 3, url: 'https://unique.com', title: 'C', groupId: -1 },
    ] as any);

    const res = await sendMsg({ type: 'find-duplicates' });
    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0]).toHaveLength(2);
  });

  it('find-duplicates returns empty when no duplicates', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://a.com', title: 'A', groupId: -1 },
      { id: 2, url: 'https://b.com', title: 'B', groupId: -1 },
    ] as any);

    const res = await sendMsg({ type: 'find-duplicates' });
    expect(res.duplicates).toHaveLength(0);
  });

  // ─── Workspace messages ───────────────────────────────────────────────────

  it('list-workspaces returns empty initially', async () => {
    const res = await sendMsg({ type: 'list-workspaces' });
    expect(res.workspaceNames).toEqual([]);
  });

  it('save-workspace saves and list-workspaces shows it', async () => {
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 1 } as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', pinned: false, active: true, groupId: -1 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);

    const saveRes = await sendMsg({ type: 'save-workspace', name: 'Work' });
    expect(saveRes.status).toBe('done');

    const listRes = await sendMsg({ type: 'list-workspaces' });
    expect(listRes.workspaceNames).toContain('Work');
  });

  it('save-workspace stores group information', async () => {
    vi.mocked(chrome.windows.getCurrent).mockResolvedValue({ id: 1 } as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 10, url: 'https://github.com', title: 'GH', pinned: false, active: true, groupId: 5 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 5, title: 'Dev', color: 'blue', windowId: 1 },
    ] as any);

    await sendMsg({ type: 'save-workspace', name: 'WithGroups' });

    const { getWorkspaces } = await import('../src/storage');
    const ws = await getWorkspaces();
    expect(ws['WithGroups'].tabs[0].groupName).toBe('Dev');
    expect(ws['WithGroups'].tabs[0].groupColor).toBe('blue');
  });

  it('restore-workspace opens tabs in new window', async () => {
    const { saveWorkspace } = await import('../src/storage');
    await saveWorkspace('restore-test', {
      name: 'restore-test',
      savedAt: Date.now(),
      tabs: [
        { url: 'https://github.com', title: 'GH', pinned: false, active: true },
        { url: 'https://docs.com', title: 'Docs', pinned: false, active: false },
      ],
    });

    vi.mocked(chrome.windows.create).mockResolvedValue({ id: 99 } as any);
    let tabIdCtr = 300;
    vi.mocked(chrome.tabs.create).mockImplementation(async () => ({
      id: tabIdCtr++,
      windowId: 99,
      groupId: -1,
      url: '',
      title: '',
      active: false,
      pinned: false,
      index: 0,
    }) as any);
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);

    const res = await sendMsg({ type: 'restore-workspace', name: 'restore-test' });
    expect(res.status).toBe('done');
    expect(chrome.windows.create).toHaveBeenCalledWith({ focused: true });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('restore-workspace returns error for unknown name', async () => {
    const res = await sendMsg({ type: 'restore-workspace', name: 'ghost' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('not found');
  });

  it('delete-workspace removes workspace', async () => {
    const { saveWorkspace } = await import('../src/storage');
    await saveWorkspace('to-delete', { name: 'to-delete', savedAt: 1, tabs: [] });

    const deleteRes = await sendMsg({ type: 'delete-workspace', name: 'to-delete' });
    expect(deleteRes.status).toBe('done');

    const listRes = await sendMsg({ type: 'list-workspaces' });
    expect(listRes.workspaceNames).not.toContain('to-delete');
  });

  // ─── Merge/Split suggestions ───────────────────────────────────────────────

  it('merge-split-suggestions returns empty when no groups', async () => {
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);
    const res = await sendMsg({ type: 'merge-split-suggestions' });
    expect(res.mergeSplit.merges).toHaveLength(0);
    expect(res.mergeSplit.splits).toHaveLength(0);
  });

  it('merge-split-suggestions detects high domain overlap as merge candidate', async () => {
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 1, title: 'Dev', windowId: 1 },
      { id: 2, title: 'Work', windowId: 1 },
    ] as any);
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.groupId === 1) return [{ id: 10, url: 'https://github.com', groupId: 1 }] as any;
      if (q?.groupId === 2) return [{ id: 20, url: 'https://github.com', groupId: 2 }] as any;
      return [];
    });

    const res = await sendMsg({ type: 'merge-split-suggestions' });
    expect(res.mergeSplit.merges.length).toBeGreaterThan(0);
    expect(res.mergeSplit.merges[0].overlap).toBeGreaterThan(60);
  });

  // ─── Search Tabs ──────────────────────────────────────────────────────────

  it('search-tabs returns matching tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com/issues', title: 'GitHub Issues', groupId: -1 },
      { id: 2, url: 'https://youtube.com', title: 'YouTube', groupId: -1 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);

    const res = await sendMsg({ type: 'search-tabs', query: 'github' });
    expect(res.tabResults).toHaveLength(1);
    expect(res.tabResults[0].url).toContain('github');
  });

  it('search-tabs returns all tabs for empty query', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', groupId: -1 },
      { id: 2, url: 'https://docs.com', title: 'Docs', groupId: -1 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([]);

    const res = await sendMsg({ type: 'search-tabs', query: '' });
    expect(res.tabResults).toHaveLength(2);
  });

  it('search-tabs includes groupName for grouped tabs', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://github.com', title: 'GH', groupId: 5 },
    ] as any);
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 5, title: 'Dev', windowId: 1 },
    ] as any);

    const res = await sendMsg({ type: 'search-tabs', query: 'github' });
    expect(res.tabResults[0].groupName).toBe('Dev');
  });

  // ─── Group stats ──────────────────────────────────────────────────────────

  it('get-group-stats returns per-group info', async () => {
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 1, title: 'Dev', color: 'blue', windowId: 1 },
    ] as any);
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.groupId === 1) {
        return [
          { id: 10, url: 'https://github.com', groupId: 1 },
          { id: 11, url: 'https://gitlab.com', groupId: 1 },
        ] as any;
      }
      return [];
    });

    const res = await sendMsg({ type: 'get-group-stats' });
    expect(res.groupStats).toHaveLength(1);
    expect(res.groupStats[0].name).toBe('Dev');
    expect(res.groupStats[0].tabCount).toBe(2);
    expect(res.groupStats[0].domains).toContain('github.com');
  });

  // ─── Export Markdown ──────────────────────────────────────────────────────

  it('export-markdown returns formatted markdown', async () => {
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 1, title: 'Dev', color: 'blue', windowId: 1 },
    ] as any);
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.groupId === 1) return [{ id: 10, url: 'https://github.com', title: 'GH', groupId: 1 }] as any;
      return [{ id: 10, url: 'https://github.com', title: 'GH', groupId: 1 }] as any;
    });

    const res = await sendMsg({ type: 'export-markdown' });
    expect(res.status).toBe('done');
    expect(res.markdown).toContain('# Tab Groups');
    expect(res.markdown).toContain('Dev');
    expect(res.markdown).toContain('github.com');
  });

  // ─── Group drift ──────────────────────────────────────────────────────────

  it('check-group-drift returns not drifted when groups are coherent', async () => {
    const { saveSettings } = await import('../src/storage');
    await saveSettings({ ...DEFAULT_SETTINGS, groupDriftThreshold: 50 });

    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 1, title: 'Dev', windowId: 1 },
    ] as any);
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.groupId === 1) {
        return [
          { id: 1, url: 'https://github.com', groupId: 1 },
          { id: 2, url: 'https://github.com/issues', groupId: 1 },
          { id: 3, url: 'https://github.com/prs', groupId: 1 },
        ] as any;
      }
      return [];
    });

    const res = await sendMsg({ type: 'check-group-drift' });
    // All same domain → 100% coherence → not drifted
    expect(res.drifted).toBe(false);
  });

  it('check-group-drift detects drifted group', async () => {
    const { saveSettings } = await import('../src/storage');
    await saveSettings({ ...DEFAULT_SETTINGS, groupDriftThreshold: 99 });

    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 1, title: 'Mixed', windowId: 1 },
    ] as any);
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.groupId === 1) {
        return [
          { id: 1, url: 'https://a.com', groupId: 1 },
          { id: 2, url: 'https://b.com', groupId: 1 },
          { id: 3, url: 'https://c.com', groupId: 1 },
        ] as any;
      }
      return [];
    });

    const res = await sendMsg({ type: 'check-group-drift' });
    expect(res.drifted).toBe(true);
    expect(res.driftedGroups).toContain('Mixed');
  });

  // ─── Corrections & Rejections ─────────────────────────────────────────────

  it('record-corrections saves learning data', async () => {
    const corrEntry = {
      timestamp: Date.now(),
      corrections: [{ domain: 'github.com', originalGroup: 'Fun', correctedGroup: 'Dev' }],
    };

    const res = await sendMsg({ type: 'record-corrections', corrections: corrEntry });
    expect(res.status).toBe('done');

    const { getCorrections } = await import('../src/storage');
    const corrections = await getCorrections();
    expect(corrections).toHaveLength(1);
    expect(corrections[0].corrections[0].domain).toBe('github.com');
  });

  it('record-corrections boosts corrected group weight 3x', async () => {
    await sendMsg({
      type: 'record-corrections',
      corrections: {
        timestamp: Date.now(),
        corrections: [{ domain: 'newdomain12345.com', originalGroup: 'Fun', correctedGroup: 'CorrectedGroup' }],
      },
    });

    const { getWeightedAffinity } = await import('../src/storage');
    const affinity = await getWeightedAffinity();
    // Correction applies 3x weight to the corrected group
    expect(affinity['newdomain12345.com']?.groups?.['CorrectedGroup']?.count).toBe(3);
  });

  it('record-rejections saves rejection data', async () => {
    const rejections = [
      { timestamp: Date.now(), domain: 'reddit.com', rejectedGroup: 'Work' },
    ];

    const res = await sendMsg({ type: 'record-rejections', rejections });
    expect(res.status).toBe('done');

    const { getRejections } = await import('../src/storage');
    const saved = await getRejections();
    expect(saved).toHaveLength(1);
    expect(saved[0].domain).toBe('reddit.com');
  });

  // ─── Export / Import data ─────────────────────────────────────────────────

  it('export-data returns full data snapshot', async () => {
    const res = await sendMsg({ type: 'export-data' });
    expect(res.data).toBeDefined();
    expect(res.data.settings).toBeDefined();
    expect(res.data.workspaces).toBeDefined();
  });

  it('import-data overwrites settings with validation', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/types');
    const importData = {
      settings: { ...DEFAULT_SETTINGS, maxGroups: 99 },
      affinity: {},
      domainRules: [],
      workspaces: {},
    };

    await sendMsg({ type: 'import-data', data: importData });

    const { getSettings } = await import('../src/storage');
    const settings = await getSettings();
    expect(settings.maxGroups).toBe(30);
  });

  // ─── Test connection ──────────────────────────────────────────────────────

  it('test-connection returns done on success', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }), { status: 200 }));

    const res = await sendMsg({ type: 'test-connection' });
    expect(res.status).toBe('done');
  });

  it('test-connection returns error on failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    const res = await sendMsg({ type: 'test-connection' });
    expect(res.status).toBe('error');
    expect(res.error).toBeDefined();
  });

  // ─── Delete all groups ─────────────────────────────────────────────────────

  it('delete-all-groups ungroups all tabs and returns count', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://a.com', groupId: 10 },
      { id: 2, url: 'https://b.com', groupId: 10 },
      { id: 3, url: 'https://c.com', groupId: 11 },
    ] as any);

    const res = await sendMsg({ type: 'delete-all-groups' });
    expect(res.count).toBe(2); // 2 unique groups
    expect(chrome.tabs.ungroup).toHaveBeenCalled();
  });

  it('delete-all-groups returns 0 when no groups exist', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://a.com', groupId: -1 },
    ] as any);

    const res = await sendMsg({ type: 'delete-all-groups' });
    expect(res.count).toBe(0);
  });

  // ─── Focus group ──────────────────────────────────────────────────────────

  it('focus-group collapses all but active group', async () => {
    vi.mocked(chrome.tabs.query).mockImplementation(async (q: any) => {
      if (q?.active === true) return [{ id: 1, url: 'https://a.com', groupId: 5, windowId: 1 }] as any;
      return [];
    });
    vi.mocked(chrome.tabGroups.query).mockResolvedValue([
      { id: 5, title: 'Active' },
      { id: 6, title: 'Other' },
    ] as any);

    const res = await sendMsg({ type: 'focus-group' });
    expect(res.status).toBe('done');
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(5, { collapsed: false });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(6, { collapsed: true });
  });

  // ─── Sort groups ───────────────────────────────────────────────────────────

  it('sort-groups returns count of sorted buckets', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: 'https://b.com', title: 'B', groupId: -1, index: 0 },
      { id: 2, url: 'https://a.com', title: 'A', groupId: -1, index: 1 },
    ] as any);

    const res = await sendMsg({ type: 'sort-groups' });
    expect(res.count).toBeGreaterThan(0);
  });
});
