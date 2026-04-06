import type { Color, GroupSuggestion, TabInfo, CorrectionEntry, RejectionEntry } from './types';
import { COLORS } from './types';
import { getSuggestions, getSettings, saveSettings } from './storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const btnOrganize = $<HTMLButtonElement>('organize');
const btnOrganizeUngrouped = $<HTMLButtonElement>('organize-ungrouped');
const btnApply = $<HTMLButtonElement>('apply-all');
const btnUndo = $<HTMLButtonElement>('undo');
const btnSettings = $<HTMLButtonElement>('open-settings');
const status = $<HTMLDivElement>('status');
const container = $<HTMLDivElement>('suggestions');
const searchInput = $<HTMLInputElement>('search');
const tabSearchResults = $<HTMLDivElement>('tab-search-results');
const statsText = $<HTMLSpanElement>('stats-text');
const costText = $<HTMLSpanElement>('cost-text');

let currentSuggestions: GroupSuggestion[] = [];
let originalSuggestions: GroupSuggestion[] = [];

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

function deepCloneSuggestions(suggestions: GroupSuggestion[]): GroupSuggestion[] {
  return suggestions.map(g => ({
    name: g.name,
    color: g.color,
    tabs: g.tabs.map(t => ({ ...t })),
  }));
}

function computeCorrections(original: GroupSuggestion[], current: GroupSuggestion[]): CorrectionEntry['corrections'] {
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

// --- Tab search ---

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
    if (searchTabsTimer) clearTimeout(searchTabsTimer);
    tabSearchResults.innerHTML = '';
    if (!q) return;
    searchTabsTimer = setTimeout(async () => {
      const res = await sendMsg({ type: 'search-tabs', query: q });
      if (res?.tabResults) renderTabSearchResults(res.tabResults);
    }, 200);
  }
});

// --- Keyboard navigation ---

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

// --- Core actions ---

async function doOrganize(ungroupedOnly: boolean) {
  setStatus('Organizing...');
  btnOrganize.disabled = true;
  btnOrganizeUngrouped.disabled = true;
  container.innerHTML = '';
  btnApply.hidden = true;

  const res = await sendMsg({ type: ungroupedOnly ? 'organize-ungrouped' : 'organize' });

  btnOrganize.disabled = false;
  btnOrganizeUngrouped.disabled = false;

  if (!res) {
    setStatus('No response — try again', true);
  } else if (res.error) {
    setStatus(res.error, true);
  } else if (res.suggestions) {
    setStatus(`${res.suggestions.length} groups suggested`);
    renderSuggestions(res.suggestions);
  } else {
    setStatus('No suggestions returned', true);
  }
}

btnOrganize.addEventListener('click', () => doOrganize(false));
btnOrganizeUngrouped.addEventListener('click', () => doOrganize(true));

btnApply.addEventListener('click', async () => {
  if (!currentSuggestions.length) return;
  setStatus('Applying...');
  btnApply.disabled = true;

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

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Footer ---

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

// --- Init ---

(async () => {
  const pending = await getSuggestions();
  if (pending?.length) {
    setStatus(`${pending.length} pending suggestions`);
    renderSuggestions(pending);
  }
  await refreshFooter();
})();
