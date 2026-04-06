import type { Color, GroupSuggestion, TabInfo, CorrectionEntry, RejectionEntry, MergeSplitResult } from './types';
import { COLORS } from './types';
import { getSuggestions, getSettings, saveSettings } from './storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const btnOrganize = $<HTMLButtonElement>('organize');
const btnOrganizeUngrouped = $<HTMLButtonElement>('organize-ungrouped');
const btnApply = $<HTMLButtonElement>('apply-all');
const btnUndo = $<HTMLButtonElement>('undo');
const btnDupes = $<HTMLButtonElement>('find-dupes');
const btnSettings = $<HTMLButtonElement>('open-settings');
const btnFocusMode = $<HTMLButtonElement>('focus-mode');
const btnSortGroups = $<HTMLButtonElement>('sort-groups');
const btnDeleteGroups = $<HTMLButtonElement>('delete-groups');
const btnExportMarkdown = $<HTMLButtonElement>('export-markdown');
const btnSnoozeTab = $<HTMLButtonElement>('snooze-tab');
const snoozePanel = $<HTMLDivElement>('snooze-panel');
const snoozeDuration = $<HTMLSelectElement>('snooze-duration');
const btnSnoozeConfirm = $<HTMLButtonElement>('snooze-confirm');
const btnSnoozeCancel = $<HTMLButtonElement>('snooze-cancel');
const status = $<HTMLDivElement>('status');
const container = $<HTMLDivElement>('suggestions');
const dupesContainer = $<HTMLDivElement>('duplicates');
const dupesWrapper = $<HTMLDivElement>('duplicates-wrapper');
const btnCloseDupes = $<HTMLButtonElement>('close-dupes');
const searchInput = $<HTMLInputElement>('search');
const tabSearchResults = $<HTMLDivElement>('tab-search-results');
const statsText = $<HTMLSpanElement>('stats-text');
const costText = $<HTMLSpanElement>('cost-text');
const workspaceNameInput = $<HTMLInputElement>('workspace-name');
const btnSaveWorkspace = $<HTMLButtonElement>('save-workspace');
const workspaceList = $<HTMLDivElement>('workspace-list');

let currentSuggestions: GroupSuggestion[] = [];
let originalSuggestions: GroupSuggestion[] = [];
let currentDupeGroups: TabInfo[][] = [];

function clearSuggestionUi() {
  currentSuggestions = [];
  container.innerHTML = '';
  searchInput.value = '';
  tabSearchResults.innerHTML = '';
  btnApply.hidden = true;
}

function setStatus(msg: string, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendMsg(msg: any): Promise<any> {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function runPowerAction(
  action: { type: string; [key: string]: unknown },
  pendingLabel: string,
  onSuccess: string | ((res: any) => string),
) {
  setStatus(pendingLabel);
  const res = await sendMsg(action);
  if (res?.error) {
    setStatus(res.error, true);
    return null;
  }
  setStatus(typeof onSuccess === 'function' ? onSuccess(res) : onSuccess);
  return res;
}

function deepCloneSuggestions(suggestions: GroupSuggestion[]): GroupSuggestion[] {
  return suggestions.map(g => ({
    name: g.name,
    color: g.color,
    tabs: g.tabs.map(t => ({ ...t })),
  }));
}

function computeCorrections(original: GroupSuggestion[], current: GroupSuggestion[]): CorrectionEntry['corrections'] {
  // Build tab→group map for original
  const originalMap = new Map<number, string>();
  for (const g of original) {
    for (const t of g.tabs) originalMap.set(t.id, g.name);
  }

  const corrections: CorrectionEntry['corrections'] = [];
  for (const g of current) {
    for (const t of g.tabs) {
      const origGroup = originalMap.get(t.id);
      if (origGroup && origGroup !== g.name) {
        try {
          const domain = new URL(t.url).hostname;
          corrections.push({ domain, originalGroup: origGroup, correctedGroup: g.name });
        } catch { /* skip */ }
      }
    }
  }

  return corrections;
}

function renderSuggestions(suggestions: GroupSuggestion[]) {
  currentSuggestions = suggestions;
  originalSuggestions = deepCloneSuggestions(suggestions);
  container.innerHTML = '';
  tabSearchResults.innerHTML = '';

  if (!suggestions.length) {
    btnApply.hidden = true;
    return;
  }

  for (let i = 0; i < suggestions.length; i++) {
    const g = suggestions[i];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <input class="group-name" value="${esc(g.name)}" data-i="${i}" />
        <select class="group-color" data-i="${i}">
          ${COLORS.map(c => `<option value="${c}" ${c === g.color ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <button class="pin-group" data-i="${i}" title="Pin this group (survives re-org)">&#x1F4CC;</button>
        <button class="remove-group" data-i="${i}">&times;</button>
      </div>
      <ul class="tab-list">
        ${g.tabs.map(t => `<li title="${esc(t.url)}">${esc(t.title || t.url)}</li>`).join('')}
      </ul>`;
    container.appendChild(card);
  }

  container.querySelectorAll<HTMLInputElement>('.group-name').forEach(el =>
    el.addEventListener('input', () => {
      currentSuggestions[Number(el.dataset.i)].name = el.value;
    }),
  );

  container.querySelectorAll<HTMLSelectElement>('.group-color').forEach(el =>
    el.addEventListener('change', () => {
      currentSuggestions[Number(el.dataset.i)].color = el.value as Color;
    }),
  );

  container.querySelectorAll<HTMLButtonElement>('.pin-group').forEach(el =>
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.i);
      const groupName = currentSuggestions[idx]?.name;
      if (!groupName) return;
      const settings = await getSettings();
      const pinned = new Set(settings.pinnedGroups);
      if (pinned.has(groupName)) {
        pinned.delete(groupName);
        setStatus(`Unpinned "${groupName}"`);
      } else {
        pinned.add(groupName);
        setStatus(`Pinned "${groupName}" — survives re-org`);
      }
      await saveSettings({ ...settings, pinnedGroups: [...pinned] });
    }),
  );

  container.querySelectorAll<HTMLButtonElement>('.remove-group').forEach(el =>
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.i);
      const removed = currentSuggestions[idx];

      // Track rejections
      if (removed) {
        const rejections: RejectionEntry[] = [];
        const now = Date.now();
        for (const tab of removed.tabs) {
          try {
            const domain = new URL(tab.url).hostname;
            rejections.push({ timestamp: now, domain, rejectedGroup: removed.name });
          } catch { /* skip */ }
        }
        if (rejections.length > 0) {
          sendMsg({ type: 'record-rejections', rejections });
        }
      }

      currentSuggestions.splice(idx, 1);
      renderSuggestions(currentSuggestions);
    }),
  );

  btnApply.hidden = false;
}

function renderTabSearchResults(results: Array<{ id: number; title: string; url: string; groupName: string; groupId: number }>) {
  tabSearchResults.innerHTML = '';
  if (!results.length) {
    tabSearchResults.innerHTML = '<div class="tab-search-empty">No tabs found</div>';
    return;
  }
  for (const tab of results.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'tab-search-row';
    row.innerHTML = `
      <div class="tab-search-info">
        <span class="tab-search-title">${esc(tab.title || tab.url)}</span>
        ${tab.groupName ? `<span class="tab-search-group">${esc(tab.groupName)}</span>` : ''}
      </div>
      <button class="btn-ghost tab-search-switch" data-id="${tab.id}">Switch</button>`;
    tabSearchResults.appendChild(row);
  }
  tabSearchResults.querySelectorAll<HTMLButtonElement>('.tab-search-switch').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = Number(btn.dataset.id);
      await chrome.tabs.update(tabId, { active: true });
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    });
  });
}

let searchTabsTimer: ReturnType<typeof setTimeout> | null = null;

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();

  if (currentSuggestions.length > 0) {
    // Filter suggestion cards
    tabSearchResults.innerHTML = '';
    container.querySelectorAll('.tab-list li').forEach(li => {
      const match = !q || li.textContent!.toLowerCase().includes(q) || li.getAttribute('title')!.toLowerCase().includes(q);
      (li as HTMLElement).style.display = match ? '' : 'none';
      li.className = q && match ? 'search-match' : '';
    });
    container.querySelectorAll<HTMLDivElement>('.card').forEach(card => {
      const hasVisible = card.querySelector('.tab-list li:not([style*="display: none"])');
      card.style.opacity = !q || hasVisible ? '1' : '0.4';
    });
  } else {
    // Global tab search mode
    if (searchTabsTimer) clearTimeout(searchTabsTimer);
    tabSearchResults.innerHTML = '';
    if (!q) return;
    searchTabsTimer = setTimeout(async () => {
      const res = await sendMsg({ type: 'search-tabs', query: q });
      if (res?.tabResults) renderTabSearchResults(res.tabResults);
    }, 200);
  }
});

// --- Keyboard navigation (F5) ---

let focusedCardIdx = -1;

function getCards(): HTMLDivElement[] {
  return Array.from(container.querySelectorAll<HTMLDivElement>('.card'));
}

function setFocusedCard(idx: number) {
  const cards = getCards();
  cards.forEach((c, i) => c.classList.toggle('focused', i === idx));
  focusedCardIdx = idx;
  if (idx >= 0 && idx < cards.length) {
    cards[idx].scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', e => {
  const inInput = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;

  if (e.key === 'Escape') {
    searchInput.value = '';
    tabSearchResults.innerHTML = '';
    container.querySelectorAll<HTMLElement>('.tab-list li').forEach(li => { li.style.display = ''; li.className = ''; });
    container.querySelectorAll<HTMLDivElement>('.card').forEach(c => { c.style.opacity = '1'; });
    setFocusedCard(-1);
    (document.activeElement as HTMLElement)?.blur?.();
    return;
  }

  if (inInput) return;

  const cards = getCards();
  if (e.key === 'ArrowDown' && cards.length) {
    e.preventDefault();
    setFocusedCard(Math.min(focusedCardIdx + 1, cards.length - 1));
  } else if (e.key === 'ArrowUp' && cards.length) {
    e.preventDefault();
    setFocusedCard(Math.max(0, focusedCardIdx - 1));
  } else if (e.key === 'Enter' && currentSuggestions.length > 0 && !btnApply.hidden) {
    e.preventDefault();
    btnApply.click();
  }
});

function renderDuplicates(groups: TabInfo[][]) {
  currentDupeGroups = groups;
  dupesContainer.innerHTML = '';
  if (!groups.length) {
    dupesWrapper.hidden = true;
    setStatus('No duplicates found');
    return;
  }

  dupesWrapper.hidden = false;
  setStatus(`Found ${groups.length} duplicate group(s)`);

  for (const g of groups) {
    const div = document.createElement('div');
    div.className = 'dupe-group';
    div.innerHTML = `<div class="dupe-title">${esc(g[0].title || g[0].url)} (${g.length}x)</div>
      <ul class="dupe-list">${g.map(t => `<li title="${esc(t.url)}">${esc(t.url)}</li>`).join('')}</ul>`;
    dupesContainer.appendChild(div);
  }
}

btnFocusMode.addEventListener('click', async () => {
  await runPowerAction(
    { type: 'focus-group' },
    'Collapsing other groups...',
    'Focus mode activated',
  );
});

btnSortGroups.addEventListener('click', async () => {
  await runPowerAction(
    { type: 'sort-groups' },
    'Sorting tab groups...',
    res => `Sorted ${res?.count ?? 0} groups`,
  );
});

btnDeleteGroups.addEventListener('click', async () => {
  const res = await runPowerAction(
    { type: 'delete-all-groups' },
    'Clearing all tab groups...',
    res => (res?.count ? `Cleared ${res.count} groups` : 'No tab groups to clear'),
  );
  if (res) clearSuggestionUi();
});

async function doOrganize(ungroupedOnly: boolean) {
  setStatus('Organizing...');
  btnOrganize.disabled = true;
  btnOrganizeUngrouped.disabled = true;
  container.innerHTML = '';
  btnApply.hidden = true;
  dupesWrapper.hidden = true;

  const res = await sendMsg({ type: ungroupedOnly ? 'organize-ungrouped' : 'organize' });

  btnOrganize.disabled = false;
  btnOrganizeUngrouped.disabled = false;

  if (res?.error) {
    setStatus(res.error, true);
  } else if (res?.suggestions) {
    setStatus(`${res.suggestions.length} groups suggested`);
    renderSuggestions(res.suggestions);
  }
}

btnOrganize.addEventListener('click', () => doOrganize(false));
btnOrganizeUngrouped.addEventListener('click', () => doOrganize(true));

btnApply.addEventListener('click', async () => {
  if (!currentSuggestions.length) return;
  setStatus('Applying...');
  btnApply.disabled = true;

  // Track corrections (user edits before applying)
  const corrections = computeCorrections(originalSuggestions, currentSuggestions);
  if (corrections.length > 0) {
    sendMsg({ type: 'record-corrections', corrections: { timestamp: Date.now(), corrections } });
  }

  await sendMsg({ type: 'apply', suggestions: currentSuggestions });
  setStatus('Applied!');
  btnApply.disabled = false;
  clearSuggestionUi();
  await refreshFooter();
});

btnUndo.addEventListener('click', async () => {
  setStatus('Undoing...');
  const res = await sendMsg({ type: 'undo' });
  setStatus(res?.error ? res.error : 'Undone!', Boolean(res?.error));
});

btnDupes.addEventListener('click', async () => {
  setStatus('Scanning...');
  const res = await sendMsg({ type: 'find-duplicates' });
  if (res?.duplicates) renderDuplicates(res.duplicates);
});

btnCloseDupes.addEventListener('click', async () => {
  if (!currentDupeGroups.length) return;
  const idsToRemove = currentDupeGroups.flatMap(group => group.slice(1).map(tab => tab.id));
  if (idsToRemove.length === 0) return;

  setStatus(`Closing ${idsToRemove.length} extra tab(s)...`);
  await chrome.tabs.remove(idsToRemove);
  setStatus(`Closed ${idsToRemove.length} extra tab(s) successfully`);
  btnDupes.click();
});

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnExportMarkdown.addEventListener('click', async () => {
  setStatus('Exporting...');
  const res = await sendMsg({ type: 'export-markdown' });
  if (res?.error) {
    setStatus(res.error, true);
    return;
  }
  try {
    await navigator.clipboard.writeText(res.markdown || '');
    setStatus('Markdown copied to clipboard!');
  } catch {
    setStatus('Export failed: clipboard access denied', true);
  }
});

async function refreshFooter() {
  const [statsRes, costsRes] = await Promise.all([
    sendMsg({ type: 'get-stats' }),
    sendMsg({ type: 'get-costs' }),
  ]);

  if (statsRes?.stats?.totalOrganizations) {
    statsText.textContent = `${statsRes.stats.totalOrganizations} organizes · ${statsRes.stats.totalTabsGrouped} tabs`;
  }

  if (costsRes?.costs?.totalCost > 0) {
    costText.textContent = `~$${costsRes.costs.totalCost.toFixed(4)} total`;
  }
}

function renderMergeSplit(result: MergeSplitResult) {
  const wrapper = document.getElementById('merge-split-wrapper');
  const container = document.getElementById('merge-split');
  if (!wrapper || !container) return;

  if (!result.merges.length && !result.splits.length) {
    wrapper.hidden = true;
    return;
  }

  wrapper.hidden = false;
  container.innerHTML = '';

  for (const m of result.merges) {
    const div = document.createElement('div');
    div.className = 'merge-split-card';
    div.innerHTML = `<span class="ms-icon">&#x1F500;</span> Merge <strong>${esc(m.group1)}</strong> + <strong>${esc(m.group2)}</strong>? (${m.overlap}% overlap)`;
    container.appendChild(div);
  }

  for (const s of result.splits) {
    const div = document.createElement('div');
    div.className = 'merge-split-card';
    div.innerHTML = `<span class="ms-icon">&#x2702;</span> Split <strong>${esc(s.group)}</strong>? (${s.tabCount} tabs, ${s.domainCount} domains)`;
    container.appendChild(div);
  }
}

(async () => {
  const pending = await getSuggestions();
  if (pending?.length) {
    setStatus(`${pending.length} pending suggestions`);
    renderSuggestions(pending);
  }
  await Promise.all([refreshFooter(), refreshWorkspaceList()]);

  // Check group drift
  const settings = await getSettings();
  if (settings.enableGroupDrift) {
    const driftRes = await sendMsg({ type: 'check-group-drift' });
    const driftWarning = document.getElementById('drift-warning');
    if (driftRes?.drifted && driftWarning) {
      driftWarning.hidden = false;
      driftWarning.querySelector('.drift-text')!.textContent =
        `Groups may need refreshing: ${driftRes.driftedGroups.join(', ')}`;
    }
  }

  // Check merge/split suggestions
  const msRes = await sendMsg({ type: 'merge-split-suggestions' });
  if (msRes?.mergeSplit) renderMergeSplit(msRes.mergeSplit);
})();

// Drift warning refresh button
document.getElementById('drift-refresh')?.addEventListener('click', () => {
  doOrganize(false);
  const dw = document.getElementById('drift-warning');
  if (dw) dw.hidden = true;
});

// --- Workspaces ---

function formatWorkspaceTime(savedAt: number): string {
  const diff = Date.now() - savedAt;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function refreshWorkspaceList() {
  const res = await sendMsg({ type: 'list-workspaces' });
  const names: string[] = res?.workspaceNames || [];
  workspaceList.innerHTML = '';

  if (!names.length) return;

  // Fetch workspace details to show time
  const wsData = await sendMsg({ type: 'export-data' });
  const workspaces = wsData?.data?.workspaces || {};

  for (const name of names) {
    const ws = workspaces[name];
    const row = document.createElement('div');
    row.className = 'workspace-row';
    const tabCount = ws?.tabs?.length ?? '?';
    const timeLabel = ws?.savedAt ? formatWorkspaceTime(ws.savedAt) : '';
    row.innerHTML = `
      <span class="workspace-name-label" title="${esc(name)}">${esc(name)}</span>
      <span class="workspace-time">${tabCount} tabs · ${timeLabel}</span>
      <button class="btn-ghost ws-restore" data-name="${esc(name)}" style="padding:3px 8px;font-size:10px;">Restore</button>
      <button class="btn-ghost danger ws-delete" data-name="${esc(name)}" style="padding:3px 6px;font-size:10px;">✕</button>`;
    workspaceList.appendChild(row);
  }

  workspaceList.querySelectorAll<HTMLButtonElement>('.ws-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name!;
      setStatus(`Restoring "${name}"...`);
      const res = await sendMsg({ type: 'restore-workspace', name });
      if (res?.error) setStatus(res.error, true);
      else setStatus(`Restored "${name}" in new window`);
    });
  });

  workspaceList.querySelectorAll<HTMLButtonElement>('.ws-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name!;
      const res = await sendMsg({ type: 'delete-workspace', name });
      if (res?.error) { setStatus(res.error, true); return; }
      await refreshWorkspaceList();
    });
  });
}

btnSaveWorkspace.addEventListener('click', async () => {
  const name = workspaceNameInput.value.trim();
  if (!name) { setStatus('Enter a workspace name', true); return; }
  setStatus('Saving workspace...');
  const res = await sendMsg({ type: 'save-workspace', name });
  if (res?.error) {
    setStatus(res.error, true);
  } else {
    workspaceNameInput.value = '';
    setStatus(`Workspace "${name}" saved`);
    await refreshWorkspaceList();
  }
});

// --- Snooze ---

btnSnoozeTab.addEventListener('click', () => {
  snoozePanel.hidden = !snoozePanel.hidden;
});

btnSnoozeCancel.addEventListener('click', () => {
  snoozePanel.hidden = true;
});

btnSnoozeConfirm.addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    setStatus('No active tab to snooze', true);
    return;
  }
  const delayMs = Number(snoozeDuration.value) || 86400000;
  const wakeAt = Date.now() + delayMs;
  setStatus('Snoozing...');
  const res = await sendMsg({ type: 'snooze-tabs', tabIds: [activeTab.id], wakeAt });
  snoozePanel.hidden = true;
  if (res?.error) {
    setStatus(res.error, true);
  } else {
    const label = snoozeDuration.options[snoozeDuration.selectedIndex]?.text || 'later';
    setStatus(`Tab snoozed until ${label}`);
  }
});
