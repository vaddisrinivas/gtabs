import type { LLMConfig, MODEL_PRICING } from './types';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function isChromeAIAvailable(): boolean {
  return typeof globalThis.LanguageModel !== 'undefined';
}

async function completeChromeAI(messages: Message[]): Promise<CompletionResult> {
  const LM = globalThis.LanguageModel;
  if (!LM) throw new Error('Chrome AI not available. Enable chrome://flags/#prompt-api-for-gemini-nano, join the extension origin trial, and restart Chrome.');

  const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userContent = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n');

  const session = await LM.create(systemPrompt ? { systemPrompt } : {});
  const content = await session.prompt(userContent);
  session.destroy();

  return {
    content,
    inputTokens: estimateTokens(systemPrompt + userContent),
    outputTokens: estimateTokens(content),
  };
}

async function completeAnthropic(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const msgs = messages.filter(m => m.role !== 'system');

  const inputText = messages.map(m => m.content).join('');

  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      temperature: 0.2,
      ...(system ? { system } : {}),
      messages: msgs,
    }),
  });

  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    content: data.content[0].text,
    inputTokens: data.usage?.input_tokens || estimateTokens(inputText),
    outputTokens: data.usage?.output_tokens || estimateTokens(data.content[0].text),
  };
}

async function completeOpenAI(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const inputText = messages.map(m => m.content).join('');

  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const content = data.choices[0].message.content;
  return {
    content,
    inputTokens: data.usage?.prompt_tokens || estimateTokens(inputText),
    outputTokens: data.usage?.completion_tokens || estimateTokens(content || ''),
  };
}

function isAnthropic(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com');
}

function isChromeAI(config: LLMConfig): boolean {
  return !config.baseUrl && config.model === 'gemini-nano';
}

export async function complete(config: LLMConfig, messages: Message[]): Promise<string> {
  const result = await completeWithUsage(config, messages);
  return result.content;
}

export async function completeWithUsage(config: LLMConfig, messages: Message[]): Promise<CompletionResult> {
  if (isChromeAI(config)) return completeChromeAI(messages);
  if (isAnthropic(config.baseUrl)) return completeAnthropic(config, messages);
  return completeOpenAI(config, messages);
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error('Could not connect to Ollama');
  const data = await res.json();
  return (data.models || []).map((m: any) => m.name || m.model);
}

export async function testConnection(config: LLMConfig): Promise<string> {
  const result = await completeWithUsage(config, [
    { role: 'user', content: 'Reply with exactly: OK' },
  ]);
  return result.content;
}
