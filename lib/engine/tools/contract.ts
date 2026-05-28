// TOOL CONTRACT — engine-internal tool definitions.
//
// PURPOSE
//   - One canonical shape every internal engine tool conforms to.
//     The contract is the single source of truth for: codegen
//     presentation (deterministic TOOLS+signatures section), the
//     sandbox bridge (mock vs runtime dispatch), and the runtime
//     itself (when a tool is later wired into a generated agent).
//
//   - Distinct from the planner-side TOOL_REGISTRY in
//     lib/engine/planner/registry.ts (which the agent + system
//     planners use to ground plans) and from the SCAFFOLD tool
//     library shipped into generated projects. This contract is
//     the future-of-record; the existing two layers stay in place
//     until each tool is migrated through.
//
// HARD INVARIANTS
//   - `name` is unique + snake_case (matches the planner registry's
//     id grammar so future migration stays drop-in).
//   - `input_schema` and `output_schema` are BOTH Zod — runtime
//     validation guarantees the LLM-facing schema and the executor
//     contract never drift.
//   - `runtime(input, ctx)` is the production implementation.
//   - `mock(input, ctx)` is ALWAYS deterministic and MUST NOT do
//     any I/O (no fetch, no fs, no random, no Date.now in the
//     output unless explicitly clamped to a deterministic value).
//   - `capabilities` declare network / external-write / destructive
//     posture HONESTLY. A tool whose runtime touches `fetch` MUST
//     declare reads_network:true — enforced via a static-shape test
//     (tests/unit/tool-capability-sweep.test.ts), same regression
//     guard pattern as the auditEngineError sweep test.
//   - `examples` carry at least 2 entries; every input + output
//     parses against the schemas at registration time.

import type { z } from 'zod';

/** Tool category — high-level kind, used for filtering + UI grouping. */
export const TOOL_CATEGORIES = [
  'compute', // pure / local — math, transforms, parsing.
  'parse', // structured extraction from text / binary.
  'fetch', // reads external data over the network.
  'persist', // writes to user-owned storage (db, fs).
  'communicate', // sends external messages (email, sms, webhook).
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/**
 * Planner-registry status. Mirrors the legacy
 * lib/engine/planner/registry.ts RegistryTool['status'] grammar
 * EXACTLY so a contract tool can derive a planner entry without
 * re-mapping:
 *   - 'available' — runs with no extra setup.
 *   - 'needs_key' — exists but requires the user to wire env keys.
 */
export const TOOL_PLANNER_STATUSES = ['available', 'needs_key'] as const;
export type ToolPlannerStatus = (typeof TOOL_PLANNER_STATUSES)[number];

/**
 * Capability declaration — the executor + sandbox bridge enforce
 * these. A tool that lies about its capabilities is the kind of
 * thing the static-shape sweep test exists to catch.
 */
export interface ToolCapabilities {
  /** True if the runtime body uses `fetch`, `http`, or any network primitive. */
  readonly reads_network: boolean;
  /** True if the runtime writes to ANY external system (db, fs outside workspace, third-party API). */
  readonly writes_external: boolean;
  /** True if the runtime can mutate user-visible state in a way that is hard or impossible to undo. */
  readonly destructive: boolean;
}

/**
 * Per-call context the runtime / mock can read. Minimal by design
 * — most internal tools don't need anything beyond their typed
 * input. Network-touching tools that need env vars read them
 * through `ctx.env`; the bridge populates `mode` so a tool can
 * branch on production vs sandbox without leaking real I/O.
 */
export interface ToolContext {
  /** 'runtime' means real execution; 'mock' means deterministic short-circuit. */
  readonly mode: 'runtime' | 'mock';
  /** Limited env access — only entries explicitly forwarded by the bridge. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Structured log sink. Tools should never `console.log`; the
   * bridge wires this to the engine's structured logger.
   */
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * PROVIDER CONNECTION — declared by a provider-backed tool (one that
 * calls an external API on the user's account). It tells the Forge:
 *   - which connection the user must bring (`provider` + `label`),
 *   - which env var the DEPLOYED AGENT reads at runtime (`env_key`),
 *   - where the user gets a key (`setup_url`),
 *   - an optional reachability shape for a connect-time verify probe.
 *
 * The key is resolved from the encrypted connection store and wired
 * into the deployed agent's env as a SERVER-ONLY var at deploy time
 * (see lib/engine/tools/provider-connections.ts). The ENGINE never
 * calls the provider API — the deployed agent does, on the user's
 * own account + quota.
 *
 * A tool that declares `provider_connection` MUST declare
 * `capabilities.reads_network: true` (enforced at registration).
 */
export interface ToolProviderConnection {
  /** Stable connection id, e.g. 'brave_search'. Stored as the `connections.provider` value. */
  readonly provider: string;
  /** Human label, e.g. 'Brave Search'. */
  readonly label: string;
  /** Env var the DEPLOYED AGENT reads, e.g. 'BRAVE_SEARCH_API_KEY'. Never NEXT_PUBLIC. */
  readonly env_key: string;
  /** Where the user obtains a key. */
  readonly setup_url?: string;
  /** Optional reachability shape for a connect-time verify probe. */
  readonly verify?: {
    readonly url: string;
    readonly method: string;
    readonly header: string;
  };
}

/** A single worked example surfaced in codegen prompts + tests. */
export interface ToolExample<I, O> {
  /** Short label (e.g. "simple sum", "kebab case"). */
  readonly label: string;
  readonly input: I;
  readonly output: O;
}

/**
 * The canonical engine-internal tool shape. Every internal tool
 * implements this interface; `registerTool` validates it at
 * import time.
 *
 * Generic over `I` (input) and `O` (output) so call sites get
 * inferred types when they invoke the tool by reference. When the
 * tool is dispatched by NAME (via the sandbox bridge), the bridge
 * re-validates via the Zod schemas — no untyped boundary.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** Unique snake_case name. Matches the planner registry's id grammar. */
  readonly name: string;
  /** LLM-facing description — should explicitly state WHEN TO USE this tool. */
  readonly description: string;
  readonly category: ToolCategory;
  readonly capabilities: ToolCapabilities;
  readonly input_schema: z.ZodType<I>;
  readonly output_schema: z.ZodType<O>;
  /**
   * Production runtime. MAY do real I/O appropriate to the tool's
   * declared capabilities. The bridge invokes this in production;
   * in sandbox tests it is NEVER invoked.
   */
  readonly runtime: (input: I, ctx: ToolContext) => Promise<O>;
  /**
   * Mock implementation — deterministic, side-effect-free. The
   * bridge invokes this when ctx.mode === 'mock' (sandbox tests +
   * dry-runs).
   */
  readonly mock: (input: I, ctx: ToolContext) => Promise<O>;
  /** ≥2 worked examples used by codegen prompts + the registration validator. */
  readonly examples: ReadonlyArray<ToolExample<I, O>>;

  // ---- SCAFFOLD SHIPPING (the source that runs in the GENERATED AGENT) ----
  //
  // Distinct from `runtime`/`mock` above (which the engine calls
  // directly for hermetic tests + future in-engine execution).
  // `scaffoldSource` is the .ts SOURCE STRING shipped verbatim into
  // a generated agent project's src/lib/tools/<name>.ts. It runs in
  // the AGENT's process and self-mocks on FORGE_MOCK_TOOLS=1, the
  // same convention the legacy scaffold used.

  /** Shippable .ts source for the generated agent. Non-empty. */
  readonly scaffoldSource: string;
  /**
   * The .d.ts-style signature line(s) for this tool, concatenated
   * into SCAFFOLD_TOOL_INTERFACE (the compact contract the codegen
   * LLM reads). Carried verbatim so the rendered interface is
   * byte-stable.
   */
  readonly scaffoldInterfaceSignature: string;
  /**
   * npm dependencies the scaffoldSource needs, merged into the
   * generated project's package.json by the emitter. Keys are
   * package names; values are semver range strings.
   */
  readonly scaffoldDependencies?: Record<string, string>;

  // ---- PLANNER COMPATIBILITY (derive a TOOL_REGISTRY entry) ----
  //
  // These let `lib/engine/planner/registry.ts` build its
  // RegistryTool[] entirely from the contract. Carried verbatim
  // from the legacy hardcoded registry for the 8 migrated tools so
  // the derived entries are field-identical.

  /** Human label shown in the planner registry + codegen TOOLS line. */
  readonly plannerLabel: string;
  /** Env keys this tool requires at runtime (planner registry env_keys). */
  readonly envKeys: readonly string[];
  /** Planner availability status. */
  readonly status: ToolPlannerStatus;

  /**
   * Present for PROVIDER-BACKED tools (web_search, future fetch/
   * communicate tools). Declares the connection the user must bring +
   * the env var wired into the deployed agent. A tool with this set
   * MUST declare capabilities.reads_network:true (enforced at
   * registration). Internal tools leave it undefined.
   */
  readonly provider_connection?: ToolProviderConnection;
}

/**
 * The tool `name` grammar: STRICT snake_case — lowercase, digits,
 * underscores; must start with a letter; NO dots, NO uppercase.
 *
 * This is enforced at registration (registry.ts). Cross-layer
 * consistency: a tool name doubles as the generated agent's export
 * stem (src/lib/tools/<name>.ts) AND must be valid as a spec
 * capability id (which is lower_snake_case, no dots) — so the
 * single snake_case grammar closes the prior namespace split where
 * dotted seed names (compute.math) couldn't be used as capabilities.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
