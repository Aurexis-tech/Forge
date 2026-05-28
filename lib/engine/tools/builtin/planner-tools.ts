// BUILTIN PLANNER TOOLS — the 8 tools migrated from the legacy
// hardcoded planner registry + scaffold into the engine tool
// contract.
//
// SOURCE OF TRUTH: each tool's `scaffoldSource` is the .ts module
// shipped verbatim into a generated agent project (carried
// byte-identical from the old agent-node-tool-using.ts), and its
// `plannerLabel` / `envKeys` / `status` are carried verbatim from
// the old TOOL_REGISTRY. lib/engine/codegen/scaffold/agent-node-
// tool-using.ts + lib/engine/planner/registry.ts now DERIVE from
// these definitions.
//
// Engine-side `runtime`/`mock` are intentionally THIN: these tools
// ship as scaffold source that runs in the GENERATED AGENT's
// process; the Forge engine never executes them directly. The thin
// deterministic mock (returning a representative, schema-valid
// shape) exists only so the contract is uniform + the registration
// validator + sandbox bridge work for them too. Crucially, the
// engine-side runtime does NO real I/O, preserving hermeticity even
// if a test dispatches one in 'runtime' mode.

import { z } from 'zod';
import type { ToolDefinition } from '../contract';

// ===========================================================================
// SCAFFOLD SOURCE STRINGS — byte-identical to the legacy
// agent-node-tool-using.ts TOOL_*_TS constants. DO NOT EDIT casually;
// the equivalence test (tool-scaffold-equivalence.test.ts) asserts
// these ship byte-for-byte unchanged.
// ===========================================================================

// PROVIDER-BACKED web_search — runs in the DEPLOYED AGENT against the
// Brave Search API, on the user's own Brave account + quota. The
// BRAVE_SEARCH_API_KEY is wired into the agent's env (SERVER-ONLY) at
// deploy time from the encrypted connection store. Self-mocks on
// FORGE_MOCK_TOOLS=1 (sandbox smoke) — NEVER fetches in mock mode.
const WEB_SEARCH_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface WebSearchInput {
  query: string;
  count?: number;
}
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchOutput {
  results: WebSearchResult[];
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

// Deterministic fixture returned in mock mode — keeps sandbox smoke
// tests hermetic (no real Brave call, no key needed).
const MOCK_OUTPUT: WebSearchOutput = {
  results: [
    {
      title: 'Example Domain',
      url: 'https://example.com',
      snippet: 'Illustrative result — sandbox mock, no real search performed.',
    },
  ],
};

export const web_search: Tool<WebSearchInput, WebSearchOutput> = {
  id: 'web_search',
  description: 'Search the web via Brave Search. Reads BRAVE_SEARCH_API_KEY.',
  async call({ query, count }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('web_search.mock', { query, count });
      return MOCK_OUTPUT;
    }
    const key = ctx.env.BRAVE_SEARCH_API_KEY;
    if (!key) {
      throw new Error(
        '[forge-agent] web_search requires BRAVE_SEARCH_API_KEY in the environment.',
      );
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    if (count != null) url.searchParams.set('count', String(count));
    ctx.log('web_search', { query, count });
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': key,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error('web_search Brave HTTP ' + res.status);
    }
    const data = (await res.json()) as BraveResponse;
    const results = (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
    return { results };
  },
};
`;

const HTTP_REQUEST_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequestInput {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}
export interface HttpRequestOutput {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export const http_request: Tool<HttpRequestInput, HttpRequestOutput> = {
  id: 'http_request',
  description: 'Make an arbitrary HTTP request and return the response.',
  async call(input, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('http_request.mock', { url: input.url, method: input.method });
      return {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked": true}',
      };
    }
    const method: HttpMethod = input.method ?? 'GET';
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    let body: BodyInit | undefined;
    if (input.body != null) {
      if (typeof input.body === 'string') {
        body = input.body;
      } else {
        body = JSON.stringify(input.body);
        if (!headers['content-type'] && !headers['Content-Type']) {
          headers['content-type'] = 'application/json';
        }
      }
    }
    ctx.log('http_request', { method, url: input.url });
    const res = await fetch(input.url, { method, headers, body });
    const text = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    return { status: res.status, ok: res.ok, headers: resHeaders, body: text };
  },
};
`;

const LLM_COMPLETION_SOURCE = `import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from './types.js';
import { isMockMode, requireEnv } from './types.js';

export interface LlmCompletionInput {
  user: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}
export interface LlmCompletionOutput {
  text: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

let client: Anthropic | null = null;
function getClient(apiKey: string): Anthropic {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

export const llm_completion: Tool<LlmCompletionInput, LlmCompletionOutput> = {
  id: 'llm_completion',
  description: 'Run a single Anthropic LLM completion.',
  async call(input, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('llm_completion.mock', { prompt_chars: input.user.length });
      return {
        text: 'Mock LLM response (sandbox smoke test — no real API call).',
        input_tokens: 0,
        output_tokens: 0,
        model: 'mock',
      };
    }
    const apiKey = requireEnv(ctx, 'ANTHROPIC_API_KEY');
    const c = getClient(apiKey);
    const model = input.model ?? ctx.env.AGENT_LLM_MODEL ?? 'claude-sonnet-4-6';
    const max_tokens = input.maxTokens ?? 2048;
    ctx.log('llm_completion', { model, max_tokens });
    const resp = await c.messages.create({
      model,
      max_tokens,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: 'user', content: input.user }],
    });
    const text = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    return {
      text,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      model: resp.model,
    };
  },
};
`;

const FILE_READ_SOURCE = `import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface FileReadInput {
  path: string;
}
export interface FileReadOutput {
  path: string;
  content: string;
  bytes: number;
}

function workspaceRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.AGENT_WORKSPACE ?? process.cwd());
}

export const file_read: Tool<FileReadInput, FileReadOutput> = {
  id: 'file_read',
  description: 'Read a UTF-8 text file from the agent workspace.',
  async call({ path }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('file_read.mock', { path });
      return { path, content: 'mock file contents', bytes: 19 };
    }
    const root = workspaceRoot(ctx.env);
    const full = resolve(root, path);
    if (!full.startsWith(root)) {
      throw new Error('[forge-agent] file_read path escapes workspace');
    }
    ctx.log('file_read', { path });
    const content = await readFile(full, 'utf8');
    return { path, content, bytes: Buffer.byteLength(content, 'utf8') };
  },
};
`;

const FILE_WRITE_SOURCE = `import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface FileWriteInput {
  path: string;
  content: string;
}
export interface FileWriteOutput {
  path: string;
  bytes: number;
}

function workspaceRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.AGENT_WORKSPACE ?? process.cwd());
}

export const file_write: Tool<FileWriteInput, FileWriteOutput> = {
  id: 'file_write',
  description: 'Write a UTF-8 text file to the agent workspace.',
  async call({ path, content }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('file_write.mock', { path, bytes: content.length });
      return { path, bytes: content.length };
    }
    const root = workspaceRoot(ctx.env);
    const full = resolve(root, path);
    if (!full.startsWith(root)) {
      throw new Error('[forge-agent] file_write path escapes workspace');
    }
    ctx.log('file_write', { path, bytes: content.length });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return { path, bytes: Buffer.byteLength(content, 'utf8') };
  },
};
`;

const SCHEDULE_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

// The schedule tool declares an intended cron expression. The hosting
// environment is responsible for actually installing the schedule (Vercel
// Cron, Cloudflare Cron Triggers, etc.). Calling this tool at runtime is
// effectively a no-op that returns the declaration for logging.

export interface ScheduleInput {
  cron: string;
}
export interface ScheduleOutput {
  cron: string;
  declared_at: string;
}

export const schedule: Tool<ScheduleInput, ScheduleOutput> = {
  id: 'schedule',
  description: 'Declare the cron schedule the hosting environment should install.',
  async call({ cron }, ctx) {
    if (!cron || typeof cron !== 'string') {
      throw new Error('[forge-agent] schedule.cron must be a non-empty string');
    }
    if (isMockMode(ctx)) {
      ctx.log('schedule.mock', { cron });
      return { cron, declared_at: new Date(0).toISOString() };
    }
    ctx.log('schedule', { cron });
    return { cron, declared_at: new Date().toISOString() };
  },
};
`;

const EMAIL_READ_SOURCE = `import type { Tool } from './types.js';
import { isMockMode, requireEnv } from './types.js';

// STUB — needs_key. Reads GMAIL_OAUTH_TOKEN and fails clearly if unset.
// Replace the body with a real Gmail API fetch when wiring up the
// integration.

export interface EmailReadInput {
  query?: string;
  limit?: number;
}
export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  received_at: string;
}
export interface EmailReadOutput {
  messages: EmailMessage[];
}

export const email_read: Tool<EmailReadInput, EmailReadOutput> = {
  id: 'email_read',
  description: 'Read recent emails from a connected Gmail mailbox.',
  async call(_input, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('email_read.mock', {});
      return { messages: [] };
    }
    requireEnv(ctx, 'GMAIL_OAUTH_TOKEN');
    throw new Error(
      '[forge-agent] email_read is not yet wired up in this scaffold. ' +
        'Implement Gmail API fetch using GMAIL_OAUTH_TOKEN here.',
    );
  },
};
`;

const EMAIL_SEND_SOURCE = `import type { Tool } from './types.js';
import { isMockMode, requireEnv } from './types.js';

// STUB — needs_key. Reads RESEND_API_KEY and fails clearly if unset.
// Replace the body with a real Resend (or other) send-email call when
// wiring up the integration.

export interface EmailSendInput {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
}
export interface EmailSendOutput {
  message_id: string;
  sent_at: string;
}

export const email_send: Tool<EmailSendInput, EmailSendOutput> = {
  id: 'email_send',
  description: 'Send an email via Resend.',
  async call(input, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('email_send.mock', { to: input.to, subject: input.subject });
      return { message_id: 'mock-' + Date.now(), sent_at: new Date(0).toISOString() };
    }
    requireEnv(ctx, 'RESEND_API_KEY');
    throw new Error(
      '[forge-agent] email_send is not yet wired up in this scaffold. ' +
        'Implement Resend send-email using RESEND_API_KEY here.',
    );
  },
};
`;

// ===========================================================================
// INTERFACE SIGNATURES — byte-identical to the legacy
// SCAFFOLD_TOOL_INTERFACE per-tool lines (alignment spacing preserved).
// ===========================================================================

const WEB_SEARCH_SIG =
  'export const web_search:     Tool<{ query: string; count?: number }, { results: { title: string; url: string; snippet: string }[] }>;  // provider: brave_search (BRAVE_SEARCH_API_KEY)';
const HTTP_REQUEST_SIG =
  "export const http_request:   Tool<{ url: string; method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; headers?: Record<string,string>; body?: string|Record<string, unknown> }, { status: number; ok: boolean; headers: Record<string,string>; body: string }>;";
const LLM_COMPLETION_SIG =
  'export const llm_completion: Tool<{ user: string; system?: string; model?: string; maxTokens?: number }, { text: string; input_tokens: number; output_tokens: number; model: string }>;';
const FILE_READ_SIG =
  'export const file_read:      Tool<{ path: string }, { path: string; content: string; bytes: number }>;';
const FILE_WRITE_SIG =
  'export const file_write:     Tool<{ path: string; content: string }, { path: string; bytes: number }>;';
const SCHEDULE_SIG =
  'export const schedule:       Tool<{ cron: string }, { cron: string; declared_at: string }>;';
const EMAIL_READ_SIG =
  'export const email_read:     Tool<{ query?: string; limit?: number }, { messages: { id: string; from: string; subject: string; body: string; received_at: string }[] }>;  // needs_key: GMAIL_OAUTH_TOKEN';
const EMAIL_SEND_SIG =
  'export const email_send:     Tool<{ to: string|string[]; subject: string; body: string; from?: string }, { message_id: string; sent_at: string }>;                       // needs_key: RESEND_API_KEY';

// ===========================================================================
// TOOL DEFINITIONS
// ===========================================================================

const webSearchInput = z.object({
  query: z.string(),
  count: z.number().optional(),
});
const webSearchOutput = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
  ),
});
type WebSearchIn = z.infer<typeof webSearchInput>;
type WebSearchOut = z.infer<typeof webSearchOutput>;

export const WEB_SEARCH_TOOL: ToolDefinition<WebSearchIn, WebSearchOut> = {
  name: 'web_search',
  description:
    'Search the public web for current information. Returns ranked results with titles, URLs, and snippets.',
  category: 'fetch',
  capabilities: { reads_network: true, writes_external: false, destructive: false },
  input_schema: webSearchInput,
  output_schema: webSearchOutput,
  // Engine-side runtime/mock are deterministic + do NO network — the
  // real Brave call happens only in the DEPLOYED AGENT (scaffoldSource).
  runtime: async (input) => representativeWebSearch(input),
  mock: async (input) => representativeWebSearch(input),
  examples: [
    {
      label: 'basic query (mock-shaped)',
      input: { query: 'arxiv computer vision' },
      output: {
        results: [
          { title: 'Result', url: 'https://example.com', snippet: 'snippet' },
        ],
      },
    },
    {
      label: 'with count',
      input: { query: 'weather', count: 3 },
      output: { results: [] },
    },
  ],
  scaffoldSource: WEB_SEARCH_SOURCE,
  scaffoldInterfaceSignature: WEB_SEARCH_SIG,
  // PROVIDER-BACKED: the deployed agent calls Brave Search on the
  // user's account. The key is wired SERVER-ONLY at deploy time.
  provider_connection: {
    provider: 'brave_search',
    label: 'Brave Search',
    env_key: 'BRAVE_SEARCH_API_KEY',
    setup_url: 'https://api-dashboard.search.brave.com/',
    verify: {
      url: 'https://api.search.brave.com/res/v1/web/search?q=test',
      method: 'GET',
      header: 'X-Subscription-Token',
    },
  },
  plannerLabel: 'Web search',
  envKeys: [],
  status: 'available',
};

function representativeWebSearch(input: WebSearchIn): WebSearchOut {
  return {
    results: [
      {
        title: 'Mock result for: ' + input.query,
        url: 'https://example.com/mock',
        snippet: 'Engine-side representative result — no network call.',
      },
    ],
  };
}

const httpRequestInput = z.object({
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
});
const httpRequestOutput = z.object({
  status: z.number(),
  ok: z.boolean(),
  headers: z.record(z.string()),
  body: z.string(),
});
type HttpReqIn = z.infer<typeof httpRequestInput>;
type HttpReqOut = z.infer<typeof httpRequestOutput>;

export const HTTP_REQUEST_TOOL: ToolDefinition<HttpReqIn, HttpReqOut> = {
  name: 'http_request',
  description:
    'Make GET/POST/PUT/DELETE requests to any reachable HTTP endpoint. Use for arbitrary REST integrations.',
  category: 'fetch',
  capabilities: { reads_network: true, writes_external: true, destructive: false },
  input_schema: httpRequestInput,
  output_schema: httpRequestOutput,
  runtime: async () => representativeHttp(),
  mock: async () => representativeHttp(),
  examples: [
    {
      label: 'GET',
      input: { url: 'https://api.example.com/items' },
      output: {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked": true}',
      },
    },
    {
      label: 'POST with body',
      input: { url: 'https://api.example.com/items', method: 'POST', body: { a: 1 } },
      output: {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked": true}',
      },
    },
  ],
  scaffoldSource: HTTP_REQUEST_SOURCE,
  scaffoldInterfaceSignature: HTTP_REQUEST_SIG,
  plannerLabel: 'HTTP request',
  envKeys: [],
  status: 'available',
};

function representativeHttp(): HttpReqOut {
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json' },
    body: '{"mocked": true}',
  };
}

const llmCompletionInput = z.object({
  user: z.string(),
  system: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
});
const llmCompletionOutput = z.object({
  text: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  model: z.string(),
});
type LlmIn = z.infer<typeof llmCompletionInput>;
type LlmOut = z.infer<typeof llmCompletionOutput>;

export const LLM_COMPLETION_TOOL: ToolDefinition<LlmIn, LlmOut> = {
  name: 'llm_completion',
  description:
    'Call an LLM from inside the agent for reasoning, summarisation, classification, or generation.',
  category: 'fetch',
  capabilities: { reads_network: true, writes_external: false, destructive: false },
  input_schema: llmCompletionInput,
  output_schema: llmCompletionOutput,
  runtime: async () => representativeLlm(),
  mock: async () => representativeLlm(),
  examples: [
    {
      label: 'summarise',
      input: { user: 'Summarise: ...' },
      output: { text: 'summary', input_tokens: 0, output_tokens: 0, model: 'mock' },
    },
    {
      label: 'with system prompt',
      input: { user: 'classify this', system: 'You are a classifier' },
      output: { text: 'label', input_tokens: 0, output_tokens: 0, model: 'mock' },
    },
  ],
  scaffoldSource: LLM_COMPLETION_SOURCE,
  scaffoldInterfaceSignature: LLM_COMPLETION_SIG,
  plannerLabel: 'LLM completion',
  envKeys: ['ANTHROPIC_API_KEY'],
  status: 'available',
};

function representativeLlm(): LlmOut {
  return {
    text: 'Engine-side representative completion — no real API call.',
    input_tokens: 0,
    output_tokens: 0,
    model: 'mock',
  };
}

const fileReadInput = z.object({ path: z.string() });
const fileReadOutput = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number(),
});
type FileReadIn = z.infer<typeof fileReadInput>;
type FileReadOut = z.infer<typeof fileReadOutput>;

export const FILE_READ_TOOL: ToolDefinition<FileReadIn, FileReadOut> = {
  name: 'file_read',
  description: "Read text files from the agent's working storage.",
  category: 'persist',
  capabilities: { reads_network: false, writes_external: false, destructive: false },
  input_schema: fileReadInput,
  output_schema: fileReadOutput,
  runtime: async (input) => ({ path: input.path, content: 'mock file contents', bytes: 19 }),
  mock: async (input) => ({ path: input.path, content: 'mock file contents', bytes: 19 }),
  examples: [
    {
      label: 'read',
      input: { path: 'data/in.txt' },
      output: { path: 'data/in.txt', content: 'mock file contents', bytes: 19 },
    },
    {
      label: 'read another',
      input: { path: 'notes.md' },
      output: { path: 'notes.md', content: 'mock file contents', bytes: 19 },
    },
  ],
  scaffoldSource: FILE_READ_SOURCE,
  scaffoldInterfaceSignature: FILE_READ_SIG,
  plannerLabel: 'File read',
  envKeys: [],
  status: 'available',
};

const fileWriteInput = z.object({ path: z.string(), content: z.string() });
const fileWriteOutput = z.object({ path: z.string(), bytes: z.number() });
type FileWriteIn = z.infer<typeof fileWriteInput>;
type FileWriteOut = z.infer<typeof fileWriteOutput>;

export const FILE_WRITE_TOOL: ToolDefinition<FileWriteIn, FileWriteOut> = {
  name: 'file_write',
  description: "Write text files to the agent's working storage.",
  category: 'persist',
  capabilities: { reads_network: false, writes_external: true, destructive: false },
  input_schema: fileWriteInput,
  output_schema: fileWriteOutput,
  runtime: async (input) => ({ path: input.path, bytes: input.content.length }),
  mock: async (input) => ({ path: input.path, bytes: input.content.length }),
  examples: [
    {
      label: 'write',
      input: { path: 'out/result.json', content: '{"ok":true}' },
      output: { path: 'out/result.json', bytes: 11 },
    },
    {
      label: 'write empty',
      input: { path: 'out/empty.txt', content: '' },
      output: { path: 'out/empty.txt', bytes: 0 },
    },
  ],
  scaffoldSource: FILE_WRITE_SOURCE,
  scaffoldInterfaceSignature: FILE_WRITE_SIG,
  plannerLabel: 'File write',
  envKeys: [],
  status: 'available',
};

const scheduleInput = z.object({ cron: z.string() });
const scheduleOutput = z.object({ cron: z.string(), declared_at: z.string() });
type ScheduleIn = z.infer<typeof scheduleInput>;
type ScheduleOut = z.infer<typeof scheduleOutput>;

export const SCHEDULE_TOOL: ToolDefinition<ScheduleIn, ScheduleOut> = {
  name: 'schedule',
  description:
    'Run the agent on a cron-like schedule (daily, hourly, every N minutes).',
  category: 'compute',
  capabilities: { reads_network: false, writes_external: false, destructive: false },
  input_schema: scheduleInput,
  output_schema: scheduleOutput,
  runtime: async (input) => ({ cron: input.cron, declared_at: new Date(0).toISOString() }),
  mock: async (input) => ({ cron: input.cron, declared_at: new Date(0).toISOString() }),
  examples: [
    {
      label: 'daily',
      input: { cron: '0 8 * * *' },
      output: { cron: '0 8 * * *', declared_at: '1970-01-01T00:00:00.000Z' },
    },
    {
      label: 'hourly',
      input: { cron: '0 * * * *' },
      output: { cron: '0 * * * *', declared_at: '1970-01-01T00:00:00.000Z' },
    },
  ],
  scaffoldSource: SCHEDULE_SOURCE,
  scaffoldInterfaceSignature: SCHEDULE_SIG,
  plannerLabel: 'Scheduled trigger',
  envKeys: [],
  status: 'available',
};

const emailReadInput = z.object({
  query: z.string().optional(),
  limit: z.number().optional(),
});
const emailReadOutput = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      subject: z.string(),
      body: z.string(),
      received_at: z.string(),
    }),
  ),
});
type EmailReadIn = z.infer<typeof emailReadInput>;
type EmailReadOut = z.infer<typeof emailReadOutput>;

export const EMAIL_READ_TOOL: ToolDefinition<EmailReadIn, EmailReadOut> = {
  name: 'email_read',
  description: 'Read incoming email from a connected mailbox.',
  category: 'communicate',
  capabilities: { reads_network: true, writes_external: false, destructive: false },
  input_schema: emailReadInput,
  output_schema: emailReadOutput,
  runtime: async () => ({ messages: [] }),
  mock: async () => ({ messages: [] }),
  examples: [
    { label: 'inbox', input: {}, output: { messages: [] } },
    { label: 'filtered', input: { query: 'invoice', limit: 5 }, output: { messages: [] } },
  ],
  scaffoldSource: EMAIL_READ_SOURCE,
  scaffoldInterfaceSignature: EMAIL_READ_SIG,
  plannerLabel: 'Email read',
  envKeys: ['GMAIL_OAUTH_TOKEN'],
  status: 'needs_key',
};

const emailSendInput = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  body: z.string(),
  from: z.string().optional(),
});
const emailSendOutput = z.object({
  message_id: z.string(),
  sent_at: z.string(),
});
type EmailSendIn = z.infer<typeof emailSendInput>;
type EmailSendOut = z.infer<typeof emailSendOutput>;

export const EMAIL_SEND_TOOL: ToolDefinition<EmailSendIn, EmailSendOut> = {
  name: 'email_send',
  description: 'Send email from a configured sender address.',
  category: 'communicate',
  capabilities: { reads_network: true, writes_external: true, destructive: false },
  input_schema: emailSendInput,
  output_schema: emailSendOutput,
  runtime: async () => ({ message_id: 'mock-0', sent_at: new Date(0).toISOString() }),
  mock: async () => ({ message_id: 'mock-0', sent_at: new Date(0).toISOString() }),
  examples: [
    {
      label: 'single recipient',
      input: { to: 'a@example.com', subject: 'Hi', body: 'Hello' },
      output: { message_id: 'mock-0', sent_at: '1970-01-01T00:00:00.000Z' },
    },
    {
      label: 'multiple recipients',
      input: { to: ['a@example.com', 'b@example.com'], subject: 'Hi', body: 'Hello' },
      output: { message_id: 'mock-0', sent_at: '1970-01-01T00:00:00.000Z' },
    },
  ],
  scaffoldSource: EMAIL_SEND_SOURCE,
  scaffoldInterfaceSignature: EMAIL_SEND_SIG,
  plannerLabel: 'Email send',
  envKeys: ['RESEND_API_KEY'],
  status: 'needs_key',
};

/**
 * The 8 builtin planner tools in their CANONICAL ORDER — matching
 * the legacy TOOL_REGISTRY + SCAFFOLD index ordering exactly. The
 * derived consumers (planner registry, scaffold file map, interface)
 * iterate this list to preserve byte/field identity.
 */
export const PLANNER_TOOLS: ReadonlyArray<ToolDefinition> = [
  WEB_SEARCH_TOOL as unknown as ToolDefinition,
  HTTP_REQUEST_TOOL as unknown as ToolDefinition,
  LLM_COMPLETION_TOOL as unknown as ToolDefinition,
  FILE_READ_TOOL as unknown as ToolDefinition,
  FILE_WRITE_TOOL as unknown as ToolDefinition,
  SCHEDULE_TOOL as unknown as ToolDefinition,
  EMAIL_READ_TOOL as unknown as ToolDefinition,
  EMAIL_SEND_TOOL as unknown as ToolDefinition,
];

/** The canonical ordered names — used by the scaffold derivation. */
export const PLANNER_TOOL_NAMES: ReadonlyArray<string> = PLANNER_TOOLS.map(
  (t) => t.name,
);
