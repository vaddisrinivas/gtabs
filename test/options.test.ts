import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resetAllMocks } from './setup';
import { DEFAULT_SETTINGS } from '../src/types';
import * as storage from '../src/storage';

const html = readFileSync(resolve(__dirname, '../src/options.html'), 'utf-8');

describe('Options Page', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    resetAllMocks();
    vi.clearAllMocks();
    
    // Reset chrome.runtime.sendMessage
    let testConnectionCallCount = 0;
    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'check-chrome-ai') cb({ available: true });
      else if (msg.type === 'fetch-ollama-models') cb({ models: ['llama2', 'mistral'] });
      else if (msg.type === 'get-stats') cb({ stats: { totalOrganizations: 10, totalTabsGrouped: 50, lastOrganizedAt: Date.now() } });
      else if (msg.type === 'get-costs') cb({ costs: { byProvider: { openai: { inputTokens: 10, outputTokens: 20, cost: 0.05 } }, totalInputTokens: 10, totalOutputTokens: 20, totalCost: 0.05 } });
      else if (msg.type === 'test-connection') {
        testConnectionCallCount += 1;
        cb(testConnectionCallCount === 1 ? { status: 'done' } : { status: 'error', error: 'Failed' });
      }
      else if (msg.type === 'export-data') cb({ data: { test: 1 } });
      else cb({ status: 'done' });
    });
  });

  it('loads and initializes the page with default settings', async () => {
    vi.spyOn(storage, 'getSettings').mockResolvedValue(DEFAULT_SETTINGS);
    vi.spyOn(storage, 'getDomainRules').mockResolvedValue([]);
    const saveSpy = vi.spyOn(storage, 'saveSettings').mockResolvedValue();
    const saveRulesSpy = vi.spyOn(storage, 'saveDomainRules').mockResolvedValue();
    
    // Dynamically import to run the init script
    await import('../src/options');
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));

    // Test Provider Selection
    const providerGrid = document.getElementById('provider-grid');
    expect(providerGrid?.children.length).toBeGreaterThan(0);
    // Click the last provider (Ollama) and confirm the selection updates
    (providerGrid!.lastElementChild as HTMLElement).click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(providerGrid!.querySelector('.provider-card.selected .name')?.textContent).toBe('Ollama (Local)');

    // Click a hosted provider and verify API key UI is shown
    (providerGrid!.children[1] as HTMLElement).click();
    expect((document.getElementById('key-row') as HTMLElement).classList.contains('hidden')).toBe(false);

    // Test range bindings and auto-save
    const maxGroups = document.getElementById('maxGroups') as HTMLInputElement;
    maxGroups.value = '10';
    maxGroups.dispatchEvent(new Event('input'));
    maxGroups.dispatchEvent(new Event('change'));
    expect(document.getElementById('maxGroupsVal')?.textContent).toBe('10');
    expect(saveSpy).toHaveBeenCalled();

    // Test Connection Button
    const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
    testBtn.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(document.getElementById('test-result')?.textContent).toBe('Connected!');
    
    // Test Connection Button Error
    (chrome.runtime.sendMessage as any).mockImplementationOnce((msg: any, cb: Function) => cb({ status: 'error', error: 'Failed' }));
    testBtn.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(document.getElementById('test-result')?.textContent).toBe('Failed');

    // Test adding a domain rule
    const btnAddRule = document.getElementById('add-rule') as HTMLButtonElement;
    btnAddRule.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(saveRulesSpy).toHaveBeenCalled();
    const ruleInput = document.querySelector('.rule-domain') as HTMLInputElement;
    expect(ruleInput).toBeTruthy();
    
    // Test rule edit
    ruleInput.value = 'github.com';
    ruleInput.dispatchEvent(new Event('change'));
    expect(saveRulesSpy).toHaveBeenCalled();

    // Test rule delete
    const delRule = document.querySelector('.rule-delete') as HTMLButtonElement;
    delRule.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(document.querySelector('.rule-domain')).toBeFalsy();

    // Test Export
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
    const exportBtn = document.getElementById('export-data') as HTMLButtonElement;
    exportBtn.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));

    // Test Import
    const importBtn = document.getElementById('import-data') as HTMLButtonElement;
    const importFile = document.getElementById('import-file') as HTMLInputElement;
    importBtn.click(); // does importFile.click()
    
    // Mock files array
    Object.defineProperty(importFile, 'files', {
      value: [new File([JSON.stringify({ settings: DEFAULT_SETTINGS })], 'export.json')]
    });
    importFile.dispatchEvent(new Event('change'));
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
  });
});
