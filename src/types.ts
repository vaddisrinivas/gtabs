export type Color = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export const COLORS: Color[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// --- Provider Presets ---

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
  canFetchModels?: boolean;
  isBuiltIn?: boolean;
  signupUrl?: string;
  helpText?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'chrome-ai', name: 'Chrome Built-in AI', baseUrl: '', models: ['gemini-nano'], needsKey: false, isBuiltIn: true, helpText: 'Requires Chrome origin trial. No API key needed.' },
  { id: 'openrouter-free', name: 'OpenRouter (Free)', baseUrl: 'https://openrouter.ai/api/v1', signupUrl: 'https://openrouter.ai/keys', helpText: 'Free, no credit card. Sign up \u2192 copy key.', models: [
    'openrouter/free',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-flash-lite',
    'deepseek/deepseek-v3.2-20251201',
    'openai/gpt-oss-120b',
    'xiaomi/mimo-v2-pro-20260318',
  ], needsKey: true },
  { id: 'groq', name: 'Groq (Free)', baseUrl: 'https://api.groq.com/openai/v1', signupUrl: 'https://console.groq.com/keys', helpText: 'Free, no credit card. Fastest inference.', models: [
    'llama-3.3-70b-versatile',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3-32b',
    'openai/gpt-oss-120b',
  ], needsKey: true },
  { id: 'grok', name: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', signupUrl: 'https://console.x.ai', helpText: '$25 free credit on signup + $150/mo via data sharing.', models: [
    'grok-4-1-fast-non-reasoning',
    'grok-4-1-fast-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-0309-reasoning',
  ], needsKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', signupUrl: 'https://console.anthropic.com/settings/keys', helpText: 'Paid. $5 free credit on signup.', models: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
  ], needsKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', signupUrl: 'https://platform.openai.com/api-keys', helpText: 'Paid. Usage-based pricing.', models: [
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
  ], needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', signupUrl: 'https://openrouter.ai/keys', helpText: 'Access 300+ models. Pay per token.', models: [
    'anthropic/claude-4.6-sonnet-20260217',
    'anthropic/claude-4.6-opus-20260205',
    'openai/gpt-5-mini-2025-08-07',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-v3.2-20251201',
  ], needsKey: true },
  { id: 'ollama', name: 'Ollama (Local)', baseUrl: 'http://localhost:11434/v1', models: [], needsKey: false, canFetchModels: true, signupUrl: 'https://ollama.com/download', helpText: 'Run models locally. Install Ollama first.' },
];

// --- Tab & Group ---

export interface TabInfo {
  id: number;
  title: string;
  url: string;
}

export interface RawGroup {
  name: string;
  color: Color;
  tabIds: number[];
}

export interface GroupSuggestion {
  name: string;
  color: Color;
  tabs: TabInfo[];
}

// --- Settings ---

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings extends LLMConfig {
  provider: string;
  autoTrigger: boolean;
  threshold: number;
  maxGroups: number;
  mergeMode: boolean;
  maxTitleLength: number;
  silentAutoAdd: boolean;
  autoPinApps: boolean;
  staleTabThresholdHours: number;
  // Smart learning
  enableCorrectionTracking: boolean;
  enableRejectionMemory: boolean;
  enableGroupDrift: boolean;
  enablePatternMining: boolean;
  groupDriftThreshold: number;
  // Scheduled re-org
  reorgSchedule: 'off' | 'daily' | 'weekly';
  reorgTime: number;
  // Pinned groups
  pinnedGroups: string[];
  // Smart ungrouping
  smartUngroup: boolean;
  // Spending cap (0 = unlimited)
  spendingCapUSD: number;
}

export interface AffinityMap {
  [domain: string]: string;
}

// --- Weighted Affinity (learning system) ---

export interface WeightedAffinityGroup {
  count: number;
  lastUsed: number;
}

export interface WeightedAffinityEntry {
  groups: Record<string, WeightedAffinityGroup>;
}

export interface WeightedAffinityMap {
  [key: string]: WeightedAffinityEntry;
}

// --- Correction Tracking ---

export interface CorrectionEntry {
  timestamp: number;
  corrections: { domain: string; originalGroup: string; correctedGroup: string }[];
}

// --- Rejection Memory ---

export interface RejectionEntry {
  timestamp: number;
  domain: string;
  rejectedGroup: string;
}

// --- Snoozed Tabs ---

export interface SnoozedTab {
  id: string;
  url: string;
  title: string;
  wakeAt: number;
}

// --- Merge/Split Suggestions ---

export interface MergeSplitResult {
  merges: { group1: string; group2: string; overlap: number }[];
  splits: { group: string; tabCount: number; domainCount: number }[];
}

export interface DomainRule {
  domain: string;
  groupName: string;
  color: Color;
}

// --- Workspaces ---

export interface WorkspaceTab {
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  groupName?: string;
  groupColor?: Color;
}

export interface Workspace {
  name: string;
  savedAt: number;
  tabs: WorkspaceTab[];
}

export interface WorkspaceMap {
  [name: string]: Workspace;
}

// --- History ---

export interface HistoryEntry {
  timestamp: number;
  groups: { name: string; domains: string[] }[];
}

// --- Costs ---

export interface CostTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  sessionCost: number;
  byProvider: Record<string, { inputTokens: number; outputTokens: number; cost: number }>;
}

export const MODEL_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'gpt-5.4': [5, 20],
  'gpt-5.4-mini': [1.5, 6],
  'gpt-5.4-nano': [0.3, 1.2],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'grok-4-1-fast-non-reasoning': [0.2, 0.5],
  'grok-4-1-fast-reasoning': [0.2, 0.5],
  'grok-4.20-0309-non-reasoning': [2, 6],
  'grok-4.20-0309-reasoning': [2, 6],
  'llama-3.3-70b-versatile': [0.59, 0.79],
  'gemini-nano': [0, 0],
  'openrouter/free': [0, 0],
};

// --- Undo ---

export interface UndoSnapshot {
  timestamp: number;
  groups: { tabId: number; groupId: number }[];
  ungrouped: number[];
}

// --- Stats ---

export interface Stats {
  totalOrganizations: number;
  totalTabsGrouped: number;
  lastOrganizedAt: number | null;
}

// --- Export ---

export interface ExportData {
  settings: Settings;
  affinity: AffinityMap;
  domainRules: DomainRule[];
  workspaces: WorkspaceMap;
  weightedAffinity?: WeightedAffinityMap;
  corrections?: CorrectionEntry[];
  rejections?: RejectionEntry[];
}

// --- Defaults ---

export const DEFAULT_SETTINGS: Settings = {
  provider: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'llama-3.3-70b-versatile',
  autoTrigger: false,
  threshold: 5,
  maxGroups: 6,
  mergeMode: false,
  maxTitleLength: 80,
  silentAutoAdd: false,
  autoPinApps: false,
  staleTabThresholdHours: 48,
  enableCorrectionTracking: true,
  enableRejectionMemory: true,
  enableGroupDrift: false,
  enablePatternMining: false,
  groupDriftThreshold: 50,
  reorgSchedule: 'off',
  reorgTime: 9,
  pinnedGroups: [],
  smartUngroup: false,
  spendingCapUSD: 0,
};

export const DEFAULT_STATS: Stats = {
  totalOrganizations: 0,
  totalTabsGrouped: 0,
  lastOrganizedAt: null,
};

export const DEFAULT_COSTS: CostTotals = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  sessionCost: 0,
  byProvider: {},
};

// --- Messages ---

export type MessageType =
  | { type: 'organize' }
  | { type: 'organize-ungrouped' }
  | { type: 'apply'; suggestions: GroupSuggestion[] }
  | { type: 'undo' }
  | { type: 'find-duplicates' }
  | { type: 'list-workspaces' }
  | { type: 'get-stats' }
  | { type: 'get-costs' }
  | { type: 'export-data' }
  | { type: 'import-data'; data: ExportData }
  | { type: 'test-connection' }
  | { type: 'check-chrome-ai' }
  | { type: 'fetch-ollama-models' }
  | { type: 'consolidate-windows' }
  | { type: 'snooze-tabs'; tabIds: number[]; wakeAt: number }
  | { type: 'purge-stale' }
  | { type: 'focus-group' }
  | { type: 'delete-all-groups' }
  | { type: 'export-markdown' }
  | { type: 'sort-groups' }
  | { type: 'save-workspace'; name: string }
  | { type: 'restore-workspace'; name: string }
  | { type: 'delete-workspace'; name: string }
  | { type: 'record-corrections'; corrections: CorrectionEntry }
  | { type: 'record-rejections'; rejections: RejectionEntry[] }
  | { type: 'check-group-drift' }
  | { type: 'merge-split-suggestions' }
  | { type: 'search-tabs'; query: string }
  | { type: 'get-group-stats' }
  | { type: 'status'; status: string; suggestions?: GroupSuggestion[]; error?: string; duplicates?: TabInfo[][]; stats?: Stats; costs?: CostTotals; data?: ExportData; models?: string[]; chatResponse?: string; markdown?: string; workspaceNames?: string[]; count?: number; drifted?: boolean; driftedGroups?: string[]; mergeSplit?: MergeSplitResult; tabResults?: Array<{ id: number; title: string; url: string; groupName: string; groupId: number }>; groupStats?: Array<{ name: string; color: string; tabCount: number; domains: string[] }> };

declare global {
  var LanguageModel: {
    create(options?: { systemPrompt?: string }): Promise<{
      prompt(text: string): Promise<string>;
      destroy(): void;
    }>;
  } | undefined;
}
