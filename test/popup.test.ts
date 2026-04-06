import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resetAllMocks } from './setup';
import * as storage from '../src/storage';

const html = readFileSync(resolve(__dirname, '../src/popup.html'), 'utf-8');

describe('Popup Page', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    resetAllMocks();
    vi.clearAllMocks();

    vi.spyOn(storage, 'getSuggestions').mockResolvedValue([{ name: 'Pending Group', color: 'blue', tabs: [{url: 'tab1.com'}] }] as any);

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'get-stats') cb({ stats: { totalOrganizations: 1, totalTabsGrouped: 5 } });
      else if (msg.type === 'get-costs') cb({ costs: { totalCost: 0.01 } });
      else cb({ status: 'done', count: 5 });
    });
  });

  it('initializes and binds core buttons', async () => {
    await import('../src/popup');
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));

    // Verify initial load processed pending suggestions
    expect(document.getElementById('status')?.textContent).toContain('1 pending');
    expect((document.getElementById('apply-all') as HTMLButtonElement).hidden).toBe(false);

    // Organize Button
    const btnOrganize = document.getElementById('organize') as HTMLButtonElement;
    (chrome.runtime.sendMessage as any).mockImplementationOnce((msg: any, cb: Function) => {
      if (msg.type === 'organize') cb({ suggestions: [{ name: 'Group 1', color: 'blue', tabs: [{url:'a.com'}, {url:'b.com'}] }] });
    });
    btnOrganize.click();
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));

    // Apply Button reveals
    const btnApply = document.getElementById('apply-all') as HTMLButtonElement;
    expect(btnApply.hidden).toBe(false);

    // Apply Button click
    btnApply.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(btnApply.hidden).toBe(true);

    // Undo
    const btnUndo = document.getElementById('undo') as HTMLButtonElement;
    btnUndo.click();
    for (let i = 0; i < 5; i++) await new Promise(r => process.nextTick(r));
    expect(document.getElementById('status')?.textContent).toContain('Undone!');

    // Settings
    const btnSettings = document.getElementById('open-settings') as HTMLButtonElement;
    btnSettings.click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();

    // Organize Ungrouped
    const btnOrganizeUngrouped = document.getElementById('organize-ungrouped') as HTMLButtonElement;
    btnOrganizeUngrouped.click();
    for (let i = 0; i < 10; i++) await new Promise(r => process.nextTick(r));

    // Error handling — no response (stuck state fix)
    (chrome.runtime.sendMessage as any).mockImplementationOnce((_msg: any, cb: Function) => cb(undefined));
    btnOrganize.click();
    for (let i = 0; i < 10; i++) await new Promise(r => process.nextTick(r));
    expect(document.getElementById('status')?.textContent).toBe('No response — try again');

    // Error handling — error response
    (chrome.runtime.sendMessage as any).mockImplementationOnce((_msg: any, cb: Function) => cb({ error: 'API Failed' }));
    btnOrganizeUngrouped.click();
    for (let i = 0; i < 10; i++) await new Promise(r => process.nextTick(r));
    expect(document.getElementById('status')?.textContent).toBe('API Failed');
  });
});
