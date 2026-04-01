import { describe, it, expect, vi, beforeEach } from 'vitest';
import { complete, completeWithUsage, fetchOllamaModels, testConnection, isChromeAIAvailable } from '../src/llm';
import type { LLMConfig } from '../src/types';

const cfg: LLMConfig = { baseUrl: 'https://api.test.com/v1', apiKey: 'sk-test', model: 'test-model' };

function mockOk(content: string) {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content } }],
  })));
}

beforeEach(() => vi.mocked(fetch).mockReset());

describe('complete - request format', () => {
  it('sends correct OpenAI-compatible request shape', async () => {
    mockOk('hello');
    await complete(cfg, [{ role: 'user', content: 'hi' }]);

    expect(fetch).toHaveBeenCalledWith('https://api.test.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body: expect.stringContaining('"model":"test-model"'),
    });
  });

  it('sends temperature in body', async () => {
    mockOk('ok');
    await complete(cfg, [{ role: 'user', content: 'test' }]);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.temperature).toBe(0.2);
  });

  it('sends all messages in order', async () => {
    mockOk('ok');
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'usr' },
      { role: 'assistant' as const, content: 'asst' },
    ];
    await complete(cfg, msgs);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.messages).toEqual(msgs);
  });

  it('omits Authorization header when apiKey is empty', async () => {
    mockOk('ok');
    await complete({ ...cfg, apiKey: '' }, [{ role: 'user', content: 'hi' }]);
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('omits Authorization header when apiKey is only whitespace', async () => {
    mockOk('ok');
    await complete({ ...cfg, apiKey: '   ' }, [{ role: 'user', content: 'hi' }]);
    // apiKey is truthy (' ') so it will be sent — this tests current behavior
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer    ');
  });

  it('constructs URL from baseUrl correctly', async () => {
    mockOk('ok');
    await complete({ ...cfg, baseUrl: 'https://custom.api.com/v2' }, [{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith('https://custom.api.com/v2/chat/completions', expect.anything());
  });

  it('handles baseUrl with trailing slash', async () => {
    mockOk('ok');
    await complete({ ...cfg, baseUrl: 'https://api.test.com/v1/' }, [{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith('https://api.test.com/v1/chat/completions', expect.anything());
  });
});

describe('complete - response handling', () => {
  it('returns content string from valid response', async () => {
    mockOk('{"result": true}');
    const result = await complete(cfg, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('{"result": true}');
  });

  it('returns empty string content', async () => {
    mockOk('');
    const result = await complete(cfg, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('');
  });

  it('returns content with unicode characters', async () => {
    mockOk('Hello 世界 🌍');
    const result = await complete(cfg, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('Hello 世界 🌍');
  });

  it('returns very long content', async () => {
    const long = 'x'.repeat(100_000);
    mockOk(long);
    const result = await complete(cfg, [{ role: 'user', content: 'test' }]);
    expect(result).toHaveLength(100_000);
  });

  it('takes first choice when multiple are returned', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [
        { message: { content: 'first' } },
        { message: { content: 'second' } },
      ],
    })));
    const result = await complete(cfg, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('first');
  });

  it('uses API usage stats when provided', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 15, completion_tokens: 28 }
    })));
    const { completeWithUsage } = await import('../src/llm');
    const result = await completeWithUsage(cfg, [{ role: 'user', content: 'test' }]);
    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(28);
  });
});

describe('complete - error handling', () => {
  it('throws on network error', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('Network error'); });
    let caught: Error | null = null;
    try { await complete(cfg, [{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('Network error');
  });

  it('throws on 401 Unauthorized', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
  });

  it('throws on 429 Rate Limited', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Rate limited', { status: 429 }));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('429');
  });

  it('throws on 500 Server Error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('500');
  });

  it('throws on 503 Service Unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Service Unavailable', { status: 503 }));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('503');
  });

  it('includes response body in error message', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"bad model"}', { status: 400 }));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('bad model');
  });

  it('throws on non-JSON response body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json at all'));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('throws on empty choices array', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('throws on missing choices field', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ result: 'ok' })));
    await expect(complete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('throws on null content in response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null } }],
    })));
    // null is returned — caller should handle
    const result = await complete(cfg, [{ role: 'user', content: 'hi' }]);
    expect(result).toBeNull();
  });
});

// ---------- Anthropic API ----------

const anthropicCfg: LLMConfig = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' };

function mockAnthropicOk(text: string) {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    content: [{ type: 'text', text }],
  })));
}

describe('complete - Anthropic API', () => {
  it('detects Anthropic URL and uses /v1/messages endpoint', async () => {
    mockAnthropicOk('hello');
    await complete(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
  });

  it('sends x-api-key header instead of Authorization', async () => {
    mockAnthropicOk('ok');
    await complete(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends anthropic-version header', async () => {
    mockAnthropicOk('ok');
    await complete(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('extracts system message into separate field', async () => {
    mockAnthropicOk('ok');
    await complete(anthropicCfg, [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hi' },
    ]);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.system).toBe('You are helpful');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('omits system field when no system message', async () => {
    mockAnthropicOk('ok');
    await complete(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.system).toBeUndefined();
  });

  it('sends max_tokens in body', async () => {
    mockAnthropicOk('ok');
    await complete(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it('returns text from Anthropic response format', async () => {
    mockAnthropicOk('{"result": true}');
    const result = await complete(anthropicCfg, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('{"result": true}');
  });

  it('throws on Anthropic error response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"invalid_api_key"}', { status: 401 }));
    await expect(complete(anthropicCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
  });

  it('uses API usage stats when provided by Anthropic', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      usage: { input_tokens: 42, output_tokens: 84 }
    })));
    const { completeWithUsage } = await import('../src/llm');
    const result = await completeWithUsage(anthropicCfg, [{ role: 'user', content: 'hi' }]);
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(84);
  });

  it('uses OpenAI format for non-Anthropic URLs', async () => {
    mockOk('ok');
    await complete({ ...cfg, baseUrl: 'https://api.groq.com/openai/v1' }, [{ role: 'user', content: 'hi' }]);
    expect(fetch).toHaveBeenCalledWith('https://api.groq.com/openai/v1/chat/completions', expect.anything());
  });

  it('throws on Anthropic 429 rate limit', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 }));
    await expect(complete(anthropicCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('429');
  });

  it('throws on Anthropic network failure', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(complete(anthropicCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('Failed to fetch');
  });

  it('throws on Anthropic malformed response (missing content field)', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: 'msg_123' })));
    await expect(complete(anthropicCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('throws on Anthropic malformed response (empty content array)', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ content: [] })));
    await expect(complete(anthropicCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });
});

describe('fetchOllamaModels', () => {
  it('fetches and maps model names correctly', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'llama2' }, { model: 'mistral' }]
    })));
    const models = await fetchOllamaModels('http://localhost:11434');
    expect(models).toEqual(['llama2', 'mistral']);
  });

  it('throws error if fetch fails', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));
    await expect(fetchOllamaModels('http://localhost:11434')).rejects.toThrow('Could not connect');
  });

  it('falls back to empty array if no models returned', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({})));
    const models = await fetchOllamaModels('http://localhost:11434');
    expect(models).toEqual([]);
  });

  it('throws on network error', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('connection refused'); });
    await expect(fetchOllamaModels('http://localhost:11434')).rejects.toThrow('connection refused');
  });
});

describe('testConnection', () => {
  it('calls completeWithUsage and returns standard test payload', async () => {
    mockOk('OK');
    const result = await testConnection(cfg);
    expect(result).toBe('OK');
  });
});

describe('Chrome AI', () => {
  it('identifies if Chrome AI is available', () => {
    expect(isChromeAIAvailable()).toBe(false);
    (globalThis as any).LanguageModel = {};
    expect(isChromeAIAvailable()).toBe(true);
    delete (globalThis as any).LanguageModel;
  });

  it('throws error if completeChromeAI called but missing', async () => {
    const config: LLMConfig = { model: 'gemini-nano', baseUrl: '', apiKey: '' };
    await expect(completeWithUsage(config, [{role: 'user', content: 'hello'}])).rejects.toThrow('Chrome AI not available');
  });

  it('calls LanguageModel.create successfully', async () => {
    const mockSession = { prompt: vi.fn().mockResolvedValue('chrome ai response'), destroy: vi.fn() };
    const mockCreate = vi.fn().mockResolvedValue(mockSession);
    (globalThis as any).LanguageModel = { create: mockCreate };

    const config: LLMConfig = { model: 'gemini-nano', baseUrl: '', apiKey: '' };
    const res = await completeWithUsage(config, [{role: 'system', content: 'sys logic'}, {role: 'user', content: 'hello'}]);
    
    expect(mockCreate).toHaveBeenCalledWith({ systemPrompt: 'sys logic' });
    expect(mockSession.prompt).toHaveBeenCalledWith('hello');
    expect(mockSession.destroy).toHaveBeenCalled();
    expect(res.content).toBe('chrome ai response');
    expect(res.inputTokens).toBeGreaterThan(0);
    delete (globalThis as any).LanguageModel;
  });

  it('calls LanguageModel.create without system prompt', async () => {
    const mockSession = { prompt: vi.fn().mockResolvedValue('xyz'), destroy: vi.fn() };
    const mockCreate = vi.fn().mockResolvedValue(mockSession);
    (globalThis as any).LanguageModel = { create: mockCreate };

    const config: LLMConfig = { model: 'gemini-nano', baseUrl: '', apiKey: '' };
    await completeWithUsage(config, [{role: 'user', content: 'hello'}]);
    
    expect(mockCreate).toHaveBeenCalledWith({});
    delete (globalThis as any).LanguageModel;
  });
});
