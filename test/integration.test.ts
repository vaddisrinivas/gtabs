import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resetAllMocks } from './setup';

const popupHtml = readFileSync(resolve(__dirname, '../src/popup.html'), 'utf-8');

describe('E2E Integration: Popup -> Background', () => {
  beforeEach(async () => {
    document.body.innerHTML = popupHtml;
    resetAllMocks();
    vi.clearAllMocks();

    // Wire up popup sendMsg to hit background listeners directly
    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      const sendResponse = (res: any) => { 
        console.log('Popup got response for', msg.type, ':', res);
        if (cb) cb(res); 
      };
      (chrome.runtime.onMessage as any).callListeners(msg, {}, sendResponse);
    });

    // 1. Load background to register its message listeners
    vi.resetModules();
    await import('../src/background');
    
    // 2. Load popup which binds DOM events
    await import('../src/popup');
    for (let i = 0; i < 15; i++) await new Promise(r => process.nextTick(r));
    
    // Set settings so it calls LLM via fetch
    const { saveSettings } = await import('../src/storage');
    const { DEFAULT_SETTINGS } = await import('../src/types');
    await saveSettings({ ...DEFAULT_SETTINGS, provider: 'openai', apiKey: 'test' });
  });

  it('runs organize through entire pipeline', async () => {
    // A. Setup mock environment for the background organizing logic
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '[{"name":"Dev Docs", "tabIds":[10, 20]}]' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    })));
    
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 10, url: 'https://github.com/PR', groupId: -1, title: 'PR 1' },
      { id: 20, url: 'https://docs.com', groupId: -1, title: 'Docs' }
    ] as any);

    // B. Trigger interaction from Popup UI
    const btnOrganize = document.getElementById('organize') as HTMLButtonElement;
    btnOrganize.click();
    
    // C. Wait for Background -> LLM -> Popup response
    for (let i = 0; i < 50; i++) await new Promise(r => process.nextTick(r));
    
    // D. Verify Popup DOM updated correctly
    expect(document.getElementById('status')?.textContent).toContain('1 groups suggested');
    const applyBtn = document.getElementById('apply-all') as HTMLButtonElement;
    expect(applyBtn.hidden).toBe(false);
    expect(document.getElementById('suggestions')?.innerHTML).toContain('Dev Docs');

    // E. Trigger Apply from Popup UI
    applyBtn.click();
    for (let i = 0; i < 30; i++) await new Promise(r => process.nextTick(r));

    // F. Verify Background grouped the tabs correctly and Popup reset
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [10, 20] });
    expect(applyBtn.hidden).toBe(true);
    expect(document.getElementById('suggestions')?.innerHTML).toBe('');
  });
});
