import type { Color, GroupSuggestion, TabInfo } from './types';
import { COLORS } from './types';
import { getSuggestions } from './storage';

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
const status = $<HTMLDivElement>('status');
const container = $<HTMLDivElement>('suggestions');
const dupesContainer = $<HTMLDivElement>('duplicates');
const dupesWrapper = $<HTMLDivElement>('duplicates-wrapper');
const btnCloseDupes = $<HTMLButtonElement>('close-dupes');
const searchInput = $<HTMLInputElement>('search');
const statsText = $<HTMLSpanElement>('stats-text');
const costText = $<HTMLSpanElement>('cost-text');

let currentSuggestions: GroupSuggestion[] = [];
let currentDupeGroups: TabInfo[][] = [];

function clearSuggestionUi() {
  currentSuggestions = [];
  container.innerHTML = '';
  searchInput.value = '';
  searchInput.style.display = 'none';
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

function renderSuggestions(suggestions: GroupSuggestion[]) {
  currentSuggestions = suggestions;
  container.innerHTML = '';
  searchInput.style.display = suggestions.length ? 'block' : 'none';

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

  container.querySelectorAll<HTMLButtonElement>('.remove-group').forEach(el =>
    el.addEventListener('click', () => {
      currentSuggestions.splice(Number(el.dataset.i), 1);
      renderSuggestions(currentSuggestions);
    }),
  );

  btnApply.hidden = false;
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();
  container.querySelectorAll('.tab-list li').forEach(li => {
    const match = !q || li.textContent!.toLowerCase().includes(q) || li.getAttribute('title')!.toLowerCase().includes(q);
    (li as HTMLElement).style.display = match ? '' : 'none';
    li.className = q && match ? 'search-match' : '';
  });
  container.querySelectorAll<HTMLDivElement>('.card').forEach(card => {
    const hasVisible = card.querySelector('.tab-list li:not([style*="display: none"])');
    card.style.opacity = !q || hasVisible ? '1' : '0.4';
  });
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
    res => `Sorted ${res?.count || 0} groups`,
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

(async () => {
  const pending = await getSuggestions();
  if (pending?.length) {
    setStatus(`${pending.length} pending suggestions`);
    renderSuggestions(pending);
  }
  await refreshFooter();
})();
