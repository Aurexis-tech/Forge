// The Forge's static V1 tool registry — the ONLY tools the planner is allowed
// to ground spec capabilities against.
//
// Adding a tool here is the FIRST step in actually supporting a new
// capability; the codegen layer (next prompt) reads from the same list when
// scaffolding the agent.
//
// `status` semantics:
//   - 'available' — tool runs with no extra setup from the user
//   - 'needs_key' — tool exists but requires the user to wire env keys before
//                   the agent can run; the plan surfaces this prominently

export interface RegistryTool {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly env_keys: readonly string[];
  readonly status: 'available' | 'needs_key';
}

export const TOOL_REGISTRY: readonly RegistryTool[] = [
  {
    id: 'web_search',
    label: 'Web search',
    description:
      'Search the public web for current information. Returns ranked results with titles, URLs, and snippets.',
    env_keys: [],
    status: 'available',
  },
  {
    id: 'http_request',
    label: 'HTTP request',
    description:
      'Make GET/POST/PUT/DELETE requests to any reachable HTTP endpoint. Use for arbitrary REST integrations.',
    env_keys: [],
    status: 'available',
  },
  {
    id: 'llm_completion',
    label: 'LLM completion',
    description:
      'Call an LLM from inside the agent for reasoning, summarisation, classification, or generation.',
    env_keys: ['ANTHROPIC_API_KEY'],
    status: 'available',
  },
  {
    id: 'file_read',
    label: 'File read',
    description: 'Read text files from the agent\'s working storage.',
    env_keys: [],
    status: 'available',
  },
  {
    id: 'file_write',
    label: 'File write',
    description: 'Write text files to the agent\'s working storage.',
    env_keys: [],
    status: 'available',
  },
  {
    id: 'schedule',
    label: 'Scheduled trigger',
    description:
      'Run the agent on a cron-like schedule (daily, hourly, every N minutes).',
    env_keys: [],
    status: 'available',
  },
  {
    id: 'email_read',
    label: 'Email read',
    description: 'Read incoming email from a connected mailbox.',
    env_keys: ['GMAIL_OAUTH_TOKEN'],
    status: 'needs_key',
  },
  {
    id: 'email_send',
    label: 'Email send',
    description: 'Send email from a configured sender address.',
    env_keys: ['RESEND_API_KEY'],
    status: 'needs_key',
  },
] as const;

export function findRegistryTool(id: string): RegistryTool | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

// Compact JSON form the LLM consumes — keeps the prompt readable.
export function registryForPrompt(): string {
  return JSON.stringify(
    TOOL_REGISTRY.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      env_keys: t.env_keys,
      status: t.status,
    })),
    null,
    2,
  );
}
