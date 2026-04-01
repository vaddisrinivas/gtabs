import type { Settings, DomainRule, Color, ProviderPreset } from './types';
import { DEFAULT_SETTINGS, PROVIDERS, COLORS } from './types';
import { getSettings, saveSettings, getDomainRules, saveDomainRules } from './storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const providerGrid = $<HTMLDivElement>('provider-grid');
const keyRow = $<HTMLDivElement>('key-row');
const inApiKey = $<HTMLInputElement>('apiKey');
const modelSelect = $<HTMLSelectElement>('model-select');
const testBtn = $<HTMLButtonElement>('test-btn');
const signupLink = $<HTMLAnchorElement>('signup-link');
const testResult = $<HTMLSpanElement>('test-result');
const inMaxGroups = $<HTMLInputElement>('maxGroups');
const outMaxGroups = $<HTMLSpanElement>('maxGroupsVal');
const inMaxTitleLength = $<HTMLInputElement>('maxTitleLength');
const outMaxTitleLength = $<HTMLSpanElement>('maxTitleVal');
const inAutoTrigger = $<HTMLInputElement>('autoTrigger');
const inThreshold = $<HTMLInputElement>('threshold');
const outThreshold = $<HTMLSpanElement>('thresholdVal');
const inMergeMode = $<HTMLInputElement>('mergeMode');
const inSilentAutoAdd = $<HTMLInputElement>('silentAutoAdd');
const inAutoPinApps = $<HTMLInputElement>('autoPinApps');
const inStaleTabThresholdHours = $<HTMLInputElement>('staleTabThresholdHours');
const outStale = $<HTMLSpanElement>('staleVal');
const inEnableCorrectionTracking = $<HTMLInputElement>('enableCorrectionTracking');
const inEnableRejectionMemory = $<HTMLInputElement>('enableRejectionMemory');
const inEnableGroupDrift = $<HTMLInputElement>('enableGroupDrift');
const inEnablePatternMining = $<HTMLInputElement>('enablePatternMining');
const inGroupDriftThreshold = $<HTMLInputElement>('groupDriftThreshold');
const outDriftThreshold = $<HTMLSpanElement>('driftThresholdVal');
const inReorgSchedule = $<HTMLSelectElement>('reorgSchedule');
const inReorgTime = $<HTMLInputElement>('reorgTime');
const outReorgTime = $<HTMLSpanElement>('reorgTimeVal');
const pinnedContainer = $<HTMLDivElement>('pinned-groups');
const inNewPinnedGroup = $<HTMLInputElement>('new-pinned-group');
const btnAddPinned = $<HTMLButtonElement>('add-pinned');
const rulesContainer = $<HTMLDivElement>('domain-rules');
const btnAddRule = $<HTMLButtonElement>('add-rule');
const btnExport = $<HTMLButtonElement>('export-data');
const btnImport = $<HTMLButtonElement>('import-data');
const importFile = $<HTMLInputElement>('import-file');
const statsLine = $<HTMLDivElement>('stats-line');
const costTable = $<HTMLTableElement>('cost-table');
const costBody = $<HTMLTableSectionElement>('cost-body');

let currentProvider: ProviderPreset | null = null;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendMsg(msg: any): Promise<any> {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// --- Provider Cards ---

let chromeAIAvailable = false;

async function checkChromeAI(): Promise<boolean> {
  try {
    const res = await sendMsg({ type: 'check-chrome-ai' });
    return res?.available === true;
  } catch { return false; }
}

function renderProviderCards(selectedId: string) {
  providerGrid.innerHTML = '';

  for (const p of PROVIDERS) {
    const card = document.createElement('div');
    card.className = 'provider-card' + (p.id === selectedId ? ' selected' : '');
    if (p.isBuiltIn && !chromeAIAvailable) card.className += ' disabled';

    let badge = '';
    if (p.isBuiltIn) badge = `<div class="badge local">${chromeAIAvailable ? 'FREE' : 'N/A'}</div>`;
    else if (p.canFetchModels) badge = '<div class="badge local">LOCAL</div>';
    card.innerHTML = `<div class="name">${esc(p.name)}</div>${badge}`;
    if (p.id === selectedId && p.helpText) {
      card.innerHTML += `<div style="font-size:10px;color:#9aa0a6;margin-top:4px">${esc(p.helpText)}</div>`;
    }

    card.addEventListener('click', () => {
      if (p.isBuiltIn && !chromeAIAvailable) return;
      selectProvider(p);
    });
    providerGrid.appendChild(card);
  }
}

function selectProvider(p: ProviderPreset) {
  currentProvider = p;

  // Update UI
  renderProviderCards(p.id);

  // Show/hide key row + signup link
  keyRow.classList.toggle('hidden', !p.needsKey);
  if (p.signupUrl) {
    signupLink.href = p.signupUrl;
    signupLink.hidden = false;
  } else {
    signupLink.hidden = true;
  }

  // Populate models
  populateModels(p.models);

  // Ollama: fetch models dynamically
  if (p.canFetchModels) {
    fetchOllamaModels();
  }

  save();
}

function populateModels(models: string[]) {
  modelSelect.innerHTML = '';
  if (!models.length) {
    modelSelect.innerHTML = '<option value="">No models available</option>';
    return;
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  }
}

// No longer auto-populating select, using range slider now.

async function fetchOllamaModels() {
  const origText = modelSelect.innerHTML;
  modelSelect.innerHTML = '<option>Loading models...</option>';
  try {
    const res = await sendMsg({ type: 'fetch-ollama-models' });
    if (res?.models?.length) {
      populateModels(res.models);
    } else {
      modelSelect.innerHTML = '<option value="">Ollama not running</option>';
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Connection failed</option>';
  }
}

// --- Save ---

async function save() {
  const p = currentProvider;
  if (!p) return;

  const model = modelSelect.value;
  const baseUrl = p.baseUrl;

  // Preserve pinnedGroups from current settings (managed separately)
  const current = await getSettings();

  const settings: Settings = {
    provider: p.id,
    baseUrl,
    apiKey: inApiKey.value,
    model,
    maxGroups: Number(inMaxGroups.value) || DEFAULT_SETTINGS.maxGroups,
    maxTitleLength: Number(inMaxTitleLength.value) || DEFAULT_SETTINGS.maxTitleLength,
    autoTrigger: inAutoTrigger.checked,
    threshold: Number(inThreshold.value) || DEFAULT_SETTINGS.threshold,
    mergeMode: inMergeMode.checked,
    silentAutoAdd: inSilentAutoAdd.checked,
    autoPinApps: inAutoPinApps.checked,
    staleTabThresholdHours: Number(inStaleTabThresholdHours.value) || DEFAULT_SETTINGS.staleTabThresholdHours,
    enableCorrectionTracking: inEnableCorrectionTracking.checked,
    enableRejectionMemory: inEnableRejectionMemory.checked,
    enableGroupDrift: inEnableGroupDrift.checked,
    enablePatternMining: inEnablePatternMining.checked,
    groupDriftThreshold: Number(inGroupDriftThreshold.value) || DEFAULT_SETTINGS.groupDriftThreshold,
    reorgSchedule: inReorgSchedule.value as Settings['reorgSchedule'],
    reorgTime: Number(inReorgTime.value),
    pinnedGroups: current.pinnedGroups || [],
  };
  await saveSettings(settings);
}

// --- Load ---

async function load() {
  chromeAIAvailable = await checkChromeAI();
  const s = await getSettings();

  // Find provider
  const p = PROVIDERS.find(provider => provider.id === s.provider)
    || PROVIDERS.find(provider => provider.id === DEFAULT_SETTINGS.provider)
    || PROVIDERS[0];
  currentProvider = p;

  renderProviderCards(p.id);
  keyRow.classList.toggle('hidden', !p.needsKey);

  inApiKey.value = s.apiKey;

  // Models
  if (p.canFetchModels) {
    await fetchOllamaModels();
  } else {
    populateModels(p.models);
  }

  // Select current model
  modelSelect.value = s.model;

  // Behavior
  inMaxGroups.value = String(s.maxGroups);
  outMaxGroups.textContent = String(s.maxGroups);
  
  inMaxTitleLength.value = String(s.maxTitleLength);
  outMaxTitleLength.textContent = String(s.maxTitleLength);
  
  inAutoTrigger.checked = s.autoTrigger;
  
  inThreshold.value = String(s.threshold);
  outThreshold.textContent = String(s.threshold);
  
  inMergeMode.checked = s.mergeMode;
  inSilentAutoAdd.checked = s.silentAutoAdd;
  inAutoPinApps.checked = s.autoPinApps;
  
  inStaleTabThresholdHours.value = String(s.staleTabThresholdHours);
  outStale.textContent = String(s.staleTabThresholdHours);

  // Smart learning
  inEnableCorrectionTracking.checked = s.enableCorrectionTracking;
  inEnableRejectionMemory.checked = s.enableRejectionMemory;
  inEnableGroupDrift.checked = s.enableGroupDrift;
  inEnablePatternMining.checked = s.enablePatternMining;
  inGroupDriftThreshold.value = String(s.groupDriftThreshold);
  outDriftThreshold.textContent = String(s.groupDriftThreshold);

  // Scheduled re-org
  inReorgSchedule.value = s.reorgSchedule;
  inReorgTime.value = String(s.reorgTime);
  outReorgTime.textContent = String(s.reorgTime);

  // Pinned groups
  renderPinnedGroups(s.pinnedGroups || []);

  // Domain rules
  await renderDomainRules();

  // Stats & costs
  await refreshData();
}

// --- Test Connection ---

testBtn.addEventListener('click', async () => {
  await save();
  testBtn.disabled = true;
  testResult.textContent = 'Testing...';
  testResult.className = 'test-result';

  const res = await sendMsg({ type: 'test-connection' });
  testBtn.disabled = false;

  if (res?.status === 'done') {
    testResult.textContent = 'Connected!';
    testResult.className = 'test-result ok';
  } else {
    testResult.textContent = res?.error || 'Failed';
    testResult.className = 'test-result fail';
  }
  setTimeout(() => { testResult.textContent = ''; }, 5000);
});

// --- Domain Rules ---

async function renderDomainRules() {
  const rules = await getDomainRules();
  rulesContainer.innerHTML = '';

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <input type="text" value="${esc(r.domain)}" placeholder="domain.com" data-i="${i}" class="rule-domain" />
      <input type="text" value="${esc(r.groupName)}" placeholder="Group Name" data-i="${i}" class="rule-group" style="max-width:120px" />
      <select data-i="${i}" class="rule-color">
        ${COLORS.map(c => `<option value="${c}" ${c === r.color ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <button class="btn-ghost btn-sm rule-delete" data-i="${i}">&times;</button>`;
    rulesContainer.appendChild(row);
  }

  // Bind handlers
  const saveRules = async () => {
    const updated: DomainRule[] = [];
    rulesContainer.querySelectorAll('.rule-row').forEach((row, i) => {
      const domain = (row.querySelector('.rule-domain') as HTMLInputElement).value;
      const groupName = (row.querySelector('.rule-group') as HTMLInputElement).value;
      const color = (row.querySelector('.rule-color') as HTMLSelectElement).value as Color;
      updated.push({ domain, groupName, color });
    });
    await saveDomainRules(updated);
  };

  rulesContainer.querySelectorAll('input, select').forEach(el =>
    el.addEventListener('change', saveRules));
  rulesContainer.querySelectorAll('.rule-delete').forEach(el =>
    el.addEventListener('click', async () => {
      const rules = await getDomainRules();
      rules.splice(Number((el as HTMLElement).dataset.i), 1);
      await saveDomainRules(rules);
      renderDomainRules();
    }));
}

btnAddRule.addEventListener('click', async () => {
  const rules = await getDomainRules();
  rules.push({ domain: '', groupName: '', color: 'grey' });
  await saveDomainRules(rules);
  renderDomainRules();
});

// --- Data ---

async function refreshData() {
  const [statsRes, costsRes] = await Promise.all([
    sendMsg({ type: 'get-stats' }),
    sendMsg({ type: 'get-costs' }),
  ]);

  if (statsRes?.stats) {
    const s = statsRes.stats;
    const last = s.lastOrganizedAt ? new Date(s.lastOrganizedAt).toLocaleDateString() : 'never';
    statsLine.innerHTML = `<strong>${s.totalOrganizations}</strong> organizes &middot; <strong>${s.totalTabsGrouped}</strong> tabs grouped &middot; Last: ${last}`;
  }

  if (costsRes?.costs) {
    const c = costsRes.costs;
    const providers = Object.entries(c.byProvider);
    if (providers.length) {
      costTable.hidden = false;
      costBody.innerHTML = '';
      for (const [name, data] of providers) {
        costBody.innerHTML += `<tr><td>${esc(name)}</td><td>${data.inputTokens.toLocaleString()}</td><td>${data.outputTokens.toLocaleString()}</td><td>$${data.cost.toFixed(4)}</td></tr>`;
      }
      costBody.innerHTML += `<tr style="border-top:1px solid #3c4043;font-weight:600"><td>Total</td><td>${c.totalInputTokens.toLocaleString()}</td><td>${c.totalOutputTokens.toLocaleString()}</td><td>$${c.totalCost.toFixed(4)}</td></tr>`;
    }
  }
}

// Export
btnExport.addEventListener('click', async () => {
  const res = await sendMsg({ type: 'export-data' });
  if (res?.data) {
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gtabs-export.json';
    a.click();
  }
});

// Import
btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await sendMsg({ type: 'import-data', data });
    await load();
  } catch { alert('Invalid import file'); }
  importFile.value = '';
});

// --- Pinned Groups ---

function renderPinnedGroups(pinnedGroups: string[]) {
  pinnedContainer.innerHTML = '';
  for (let i = 0; i < pinnedGroups.length; i++) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <input type="text" value="${esc(pinnedGroups[i])}" readonly style="flex:1;opacity:0.8" />
      <button class="btn-ghost btn-sm pinned-delete" data-i="${i}">&times;</button>`;
    pinnedContainer.appendChild(row);
  }

  pinnedContainer.querySelectorAll('.pinned-delete').forEach(el =>
    el.addEventListener('click', async () => {
      const s = await getSettings();
      const groups = [...(s.pinnedGroups || [])];
      groups.splice(Number((el as HTMLElement).dataset.i), 1);
      await saveSettings({ ...s, pinnedGroups: groups });
      renderPinnedGroups(groups);
    }),
  );
}

btnAddPinned.addEventListener('click', async () => {
  const name = inNewPinnedGroup.value.trim();
  if (!name) return;
  const s = await getSettings();
  const groups = [...(s.pinnedGroups || [])];
  if (!groups.includes(name)) groups.push(name);
  await saveSettings({ ...s, pinnedGroups: groups });
  renderPinnedGroups(groups);
  inNewPinnedGroup.value = '';
});

// --- Auto-save on changes ---
const rangeBindings = [
  { input: inMaxGroups, out: outMaxGroups },
  { input: inMaxTitleLength, out: outMaxTitleLength },
  { input: inThreshold, out: outThreshold },
  { input: inStaleTabThresholdHours, out: outStale },
  { input: inGroupDriftThreshold, out: outDriftThreshold },
  { input: inReorgTime, out: outReorgTime },
];
for (const b of rangeBindings) {
  b.input.addEventListener('input', () => { b.out.textContent = b.input.value; });
}

const autoSaveElements = [
  inApiKey, modelSelect, inMaxGroups, inMaxTitleLength, inAutoTrigger, inThreshold,
  inMergeMode, inSilentAutoAdd, inAutoPinApps, inStaleTabThresholdHours,
  inEnableCorrectionTracking, inEnableRejectionMemory, inEnableGroupDrift,
  inEnablePatternMining, inGroupDriftThreshold,
  inReorgSchedule, inReorgTime,
];
for (const el of autoSaveElements) {
  el.addEventListener('change', save);
  if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'password' || el.type === 'number' || el.type === 'range')) {
    el.addEventListener('input', save);
  }
}

// --- Init ---
load();
