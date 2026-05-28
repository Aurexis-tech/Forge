// FORGE TIMELINE ASSEMBLER — a single chronological view per
// project, merged from every per-project source table the engine
// writes to. Read-side abstraction; pure function; no caching, no
// side effects. RLS-respecting (uses the existing server Supabase
// client which the route layer scopes via requireUser / project
// ownership; this module never bypasses RLS).
//
// CONSUMERS
//   - The (next-prompt) observability UI panel renders the
//     timeline.
//   - Future on-call dashboards / alerting can query this
//     server-side.
//
// HARD INVARIANTS
//   - The function NEVER writes. It only reads.
//   - Default `limit` = 200. Hard ceiling = 1000 to bound the
//     query surface regardless of caller input.
//   - Per-source fetches are CAPPED independently to keep one
//     loud source from starving the others.
//   - Engine errors surface their CATEGORY by reading the
//     `engine_error_category` key from audit_log.detail JSONB
//     (written by lib/engine/observability/audit-engine-error.ts).
//     When absent (old rows / non-error audits), category=null.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  AgentRun,
  AgentRuntime,
  AuditLog,
  Build,
  CostEvent,
  Deployment,
  InfraApply,
  InfraPlan,
  Json,
  SandboxRun,
  SoftwareDatabase,
} from '@/lib/types';
import { ERROR_CATEGORIES, type ErrorCategory } from '../errors';

// ===========================================================================
// PUBLIC SHAPES
// ===========================================================================

export type ForgeTimelineEventKind =
  | 'audit'
  | 'cost'
  | 'build_status'
  | 'sandbox'
  | 'deploy'
  | 'software_db'
  | 'infra_plan'
  | 'infra_apply'
  | 'runtime_status'
  | 'run';

export type ForgeTimelineLevel = 'info' | 'warn' | 'error';

export interface ForgeTimelineEvent {
  /** Per-source row id (stringified). NOT globally unique across sources — combine with `kind` to dedupe in UIs. */
  readonly id: string;
  readonly timestamp: string;
  readonly kind: ForgeTimelineEventKind;
  /** EngineError category when the event represents a classified failure; null otherwise. */
  readonly category: ErrorCategory | null;
  readonly level: ForgeTimelineLevel;
  /** Short human-readable message ("spec extracted", "codegen retry 2: transient_provider", etc.). */
  readonly message: string;
  /** Cost-ledger / governance ref the event correlates with, when present. */
  readonly ref: string | null;
  /** Cost in USD for cost events; null otherwise. */
  readonly cost_usd: number | null;
  /** Raw row details — opaque per-kind blob the UI can drill into. */
  readonly details: Record<string, unknown>;
}

export type ForgeTimelinePhase =
  | 'codegen'
  | 'critique'
  | 'refine'
  | 'sandbox'
  | 'runtime'
  | 'spec_extract'
  | 'clarification'
  | 'judge'
  | 'other';

export interface ForgeTimelinePhaseCosts {
  readonly codegen: number;
  readonly critique: number;
  readonly refine: number;
  readonly sandbox: number;
  readonly runtime: number;
  readonly spec_extract: number;
  readonly clarification: number;
  readonly judge: number;
  readonly other: number;
}

export interface ForgeTimeline {
  readonly events: ReadonlyArray<ForgeTimelineEvent>;
  readonly phaseCosts: ForgeTimelinePhaseCosts;
  readonly totalCostUsd: number;
  /** True when the query was capped — caller can paginate via `before`. */
  readonly truncated: boolean;
}

export interface AssembleForgeTimelineOptions {
  /** Default 200, hard ceiling 1000. */
  limit?: number;
  /** Pagination cursor — ISO timestamp; events strictly EARLIER than this are returned. */
  before?: string;
}

const DEFAULT_LIMIT = 200;
const HARD_CEILING = 1000;
const PER_SOURCE_CAP = 250;

// ===========================================================================
// MAIN ENTRY
// ===========================================================================
export async function assembleForgeTimeline(
  supabase: ForgeSupabase,
  projectId: string,
  opts: AssembleForgeTimelineOptions = {},
): Promise<ForgeTimeline> {
  const limit = Math.min(
    Math.max(1, opts.limit ?? DEFAULT_LIMIT),
    HARD_CEILING,
  );
  const before = opts.before;

  // ---- Phase 1: project-scoped tables --------------------------------------
  const [audits, costs, builds, swDbs, infraPlans, infraApplies, runtimes] =
    await Promise.all([
      fetchAudit(supabase, projectId, before),
      fetchCost(supabase, projectId, before),
      fetchBuilds(supabase, projectId, before),
      fetchSoftwareDbs(supabase, projectId, before),
      fetchInfraPlans(supabase, projectId, before),
      fetchInfraApplies(supabase, projectId, before),
      fetchRuntimes(supabase, projectId, before),
    ]);

  // ---- Phase 2: build/runtime-scoped tables (need ids from phase 1) -------
  const buildIds = builds.map((b) => b.id);
  const runtimeIds = runtimes.map((r) => r.id);
  const [sandboxRuns, deployments, runs] = await Promise.all([
    buildIds.length === 0
      ? Promise.resolve<SandboxRun[]>([])
      : fetchSandboxRuns(supabase, buildIds, before),
    buildIds.length === 0
      ? Promise.resolve<Deployment[]>([])
      : fetchDeployments(supabase, buildIds, before),
    runtimeIds.length === 0
      ? Promise.resolve<AgentRun[]>([])
      : fetchRuns(supabase, runtimeIds, before),
  ]);

  // ---- Phase 3: normalise + merge ------------------------------------------
  const events: ForgeTimelineEvent[] = [
    ...audits.map(eventFromAudit),
    ...costs.map(eventFromCost),
    ...builds.map(eventFromBuild),
    ...sandboxRuns.map(eventFromSandboxRun),
    ...deployments.map(eventFromDeployment),
    ...swDbs.map(eventFromSoftwareDb),
    ...infraPlans.map(eventFromInfraPlan),
    ...infraApplies.map(eventFromInfraApply),
    ...runtimes.map(eventFromRuntime),
    ...runs.map(eventFromRun),
  ];
  // DESC chronological (newest first — typical for timelines).
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const truncated = events.length > limit;
  const sliced = events.slice(0, limit);

  // ---- Phase 4: cost roll-ups ----------------------------------------------
  const phaseCosts = aggregateCosts(costs);
  const totalCostUsd = costs.reduce((acc, c) => acc + (c.amount_usd ?? 0), 0);

  return { events: sliced, phaseCosts, totalCostUsd, truncated };
}

// ===========================================================================
// FETCHERS — each capped, each filtered by `before` when supplied. We
// use `select('*')` so additive columns (confidence_json, etc.) don't
// surprise this layer.
// ===========================================================================

async function fetchAudit(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<AuditLog[]> {
  let q = supabase
    .from('audit_log')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AuditLog[];
}

async function fetchCost(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<CostEvent[]> {
  let q = supabase
    .from('cost_events')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CostEvent[];
}

async function fetchBuilds(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<Build[]> {
  let q = supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Build[];
}

async function fetchSoftwareDbs(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<SoftwareDatabase[]> {
  let q = supabase
    .from('software_databases')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as SoftwareDatabase[];
}

async function fetchInfraPlans(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<InfraPlan[]> {
  let q = supabase
    .from('infra_plans')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as InfraPlan[];
}

async function fetchInfraApplies(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<InfraApply[]> {
  let q = supabase
    .from('infra_applies')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as InfraApply[];
}

async function fetchRuntimes(
  supabase: ForgeSupabase,
  projectId: string,
  before: string | undefined,
): Promise<AgentRuntime[]> {
  // For runtimes we order by updated_at since status changes
  // mutate the row in place rather than appending new rows.
  let q = supabase
    .from('agent_runtimes')
    .select('*')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('updated_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AgentRuntime[];
}

async function fetchSandboxRuns(
  supabase: ForgeSupabase,
  buildIds: ReadonlyArray<string>,
  before: string | undefined,
): Promise<SandboxRun[]> {
  let q = supabase
    .from('sandbox_runs')
    .select('*')
    .in('build_id', buildIds)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as SandboxRun[];
}

async function fetchDeployments(
  supabase: ForgeSupabase,
  buildIds: ReadonlyArray<string>,
  before: string | undefined,
): Promise<Deployment[]> {
  let q = supabase
    .from('deployments')
    .select('*')
    .in('build_id', buildIds)
    .order('created_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Deployment[];
}

async function fetchRuns(
  supabase: ForgeSupabase,
  runtimeIds: ReadonlyArray<string>,
  before: string | undefined,
): Promise<AgentRun[]> {
  let q = supabase
    .from('runs')
    .select('*')
    .in('runtime_id', runtimeIds)
    .order('started_at', { ascending: false })
    .limit(PER_SOURCE_CAP);
  if (before) q = q.lt('started_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AgentRun[];
}

// ===========================================================================
// EVENT NORMALISATION — one function per source. Pure.
// ===========================================================================

function readEngineErrorCategory(detail: Json): ErrorCategory | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return null;
  }
  const v = (detail as Record<string, unknown>).engine_error_category;
  if (typeof v !== 'string') return null;
  if ((ERROR_CATEGORIES as readonly string[]).includes(v)) {
    return v as ErrorCategory;
  }
  return null;
}

function detailToRecord(detail: Json): Record<string, unknown> {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return {};
  }
  return detail as Record<string, unknown>;
}

function levelFromAuditAction(
  action: string,
  category: ErrorCategory | null,
): ForgeTimelineLevel {
  // If the audit row carries an engine error, surface its severity:
  //  - transient_provider → warn (we retried; may have succeeded)
  //  - governance / auth / bad_input / permission / not_found / permanent_provider / internal → error
  if (category !== null) {
    if (category === 'transient_provider') return 'warn';
    return 'error';
  }
  // Otherwise, infer from the action name. The audit_log action vocab
  // already encodes outcome (e.g. *_failed / *_killed / *_max_reached).
  if (/(failed|killed|killswitched|rejected|aborted|max_reached)/i.test(action)) {
    return 'error';
  }
  if (/(warning|retry|drift|paused)/i.test(action)) {
    return 'warn';
  }
  return 'info';
}

function eventFromAudit(row: AuditLog): ForgeTimelineEvent {
  const details = detailToRecord(row.detail);
  const category = readEngineErrorCategory(row.detail);
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'audit',
    category,
    level: levelFromAuditAction(row.action, category),
    message: humaniseAuditAction(row.action, category),
    ref:
      typeof details.governance_ref === 'string'
        ? (details.governance_ref as string)
        : null,
    cost_usd: null,
    details,
  };
}

function humaniseAuditAction(
  action: string,
  category: ErrorCategory | null,
): string {
  // `action` is dot-separated noun.verb (e.g. 'spec.draft_generated',
  // 'codegen.critique_completed'). Surface it verbatim plus the
  // category tag when an EngineError fired.
  if (category !== null) {
    return action + ' [' + category + ']';
  }
  return action;
}

function eventFromCost(row: CostEvent): ForgeTimelineEvent {
  const phase = phaseForRef(row.ref);
  const refTail = row.ref ?? '(no ref)';
  // Surface a prompt-cache hit inline so the timeline visibly shows the
  // savings lever firing (cache reads are billed at 0.1x). Older rows
  // predating the cache columns read back as 0 → no suffix.
  const cacheRead = row.cache_read_input_tokens ?? 0;
  const cacheCreation = row.cache_creation_input_tokens ?? 0;
  const cacheNote =
    cacheRead > 0 ? ' · cache_read ' + cacheRead : cacheCreation > 0 ? ' · cache_write ' + cacheCreation : '';
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'cost',
    category: null,
    level: 'info',
    message:
      '$' +
      row.amount_usd.toFixed(4) +
      ' ' +
      (row.kind === 'llm' ? 'llm' : row.kind) +
      ' · ' +
      phase +
      ' · ' +
      refTail +
      cacheNote,
    ref: row.ref,
    cost_usd: row.amount_usd,
    details: {
      kind: row.kind,
      model: row.model,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      compute_ms: row.compute_ms,
      key_source: row.key_source,
      ref: row.ref,
      phase,
    },
  };
}

function eventFromBuild(row: Build): ForgeTimelineEvent {
  const status = String(row.status);
  return {
    id: row.id,
    timestamp: row.updated_at ?? row.created_at,
    kind: 'build_status',
    category: null,
    level: /(failed|killswitched)/i.test(status) ? 'error' : 'info',
    message: 'build ' + row.kind + ' → ' + status,
    ref: null,
    cost_usd: null,
    details: {
      build_id: row.id,
      kind: row.kind,
      status: row.status,
      phase: row.phase,
      spec_id: row.spec_id,
      plan_id: row.plan_id,
      repo_url: row.repo_url,
      deploy_url: row.deploy_url,
    },
  };
}

function eventFromSandboxRun(row: SandboxRun): ForgeTimelineEvent {
  const status = String(row.status);
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'sandbox',
    category: null,
    level: status === 'failed' ? 'error' : 'info',
    message: 'sandbox ' + row.provider + ' → ' + status,
    ref: null,
    cost_usd: null,
    details: {
      sandbox_run_id: row.id,
      build_id: row.build_id,
      provider: row.provider,
      status: row.status,
      build_ok: row.build_ok,
      smoke_ok: row.smoke_ok,
      duration_ms: row.duration_ms,
      iterations: row.iterations,
      error: row.error,
    },
  };
}

function eventFromDeployment(row: Deployment): ForgeTimelineEvent {
  const status = String(row.status ?? '');
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'deploy',
    category: null,
    level: /(failed|error)/i.test(status) ? 'error' : 'info',
    message:
      'deploy ' + row.provider + (status ? ' → ' + status : '') +
      (row.url ? ' (' + row.url + ')' : ''),
    ref: null,
    cost_usd: null,
    details: {
      deployment_id: row.id,
      build_id: row.build_id,
      provider: row.provider,
      project_ref: row.project_ref,
      provider_deployment_id: row.deployment_id,
      status: row.status,
      url: row.url,
      env_keys: row.env_keys,
    },
  };
}

function eventFromSoftwareDb(row: SoftwareDatabase): ForgeTimelineEvent {
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'software_db',
    category: null,
    level: 'info',
    message:
      'software_db ' + row.provider_kind + ' provisioned' +
      (row.migration_applied ? ' (migrated)' : ' (pending migration)'),
    ref: null,
    cost_usd: null,
    details: {
      software_db_id: row.id,
      build_id: row.build_id,
      provider_kind: row.provider_kind,
      supabase_url: row.supabase_url,
      provider_project_ref: row.provider_project_ref,
      migration_applied: row.migration_applied,
      service_role_last4: row.service_role_last4,
    },
  };
}

function eventFromInfraPlan(row: InfraPlan): ForgeTimelineEvent {
  return {
    id: row.id,
    timestamp: row.created_at,
    kind: 'infra_plan',
    category: null,
    level: row.destructive ? 'warn' : 'info',
    message:
      'infra_plan · +' +
      row.create_count +
      ' / ~' +
      row.change_count +
      ' / -' +
      row.destroy_count +
      ' · ceiling=' +
      row.ceiling_verdict,
    ref: null,
    cost_usd: null,
    details: {
      infra_plan_id: row.id,
      build_id: row.build_id,
      destructive: row.destructive,
      create_count: row.create_count,
      change_count: row.change_count,
      destroy_count: row.destroy_count,
      ceiling_verdict: row.ceiling_verdict,
      ceiling_projected_usd: row.ceiling_projected_usd,
      ceiling_limit_usd: row.ceiling_limit_usd,
      confirmed_at: row.confirmed_at,
    },
  };
}

function eventFromInfraApply(row: InfraApply): ForgeTimelineEvent {
  const status = String(row.status);
  return {
    id: row.id,
    timestamp: row.finished_at ?? row.created_at,
    kind: 'infra_apply',
    category: null,
    level: /(failed|killswitched)/i.test(status) ? 'error' : 'info',
    message:
      'infra_apply → ' + status +
      ' · +' + row.resources_added +
      ' / ~' + row.resources_changed +
      ' / -' + row.resources_destroyed,
    ref: null,
    cost_usd: null,
    details: {
      infra_apply_id: row.id,
      build_id: row.build_id,
      plan_id: row.plan_id,
      status: row.status,
      killswitched: row.killswitched,
      partial_state: row.partial_state,
      resources_added: row.resources_added,
      resources_changed: row.resources_changed,
      resources_destroyed: row.resources_destroyed,
      billed_usd_per_month: row.billed_usd_per_month,
      error_message: row.error_message,
      finished_at: row.finished_at,
    },
  };
}

function eventFromRuntime(row: AgentRuntime): ForgeTimelineEvent {
  const status = String(row.status);
  return {
    id: row.id,
    timestamp: row.updated_at,
    kind: 'runtime_status',
    category: null,
    level: status === 'errored' ? 'error' : status === 'paused' ? 'warn' : 'info',
    message: 'runtime ' + row.kind + ' (' + row.mode + ') → ' + status,
    ref: null,
    cost_usd: null,
    details: {
      runtime_id: row.id,
      build_id: row.build_id,
      kind: row.kind,
      mode: row.mode,
      status: row.status,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      run_count: row.run_count,
      fail_count: row.fail_count,
      consecutive_fails: row.consecutive_fails,
    },
  };
}

function eventFromRun(row: AgentRun): ForgeTimelineEvent {
  const status = String(row.status);
  return {
    id: row.id,
    timestamp: row.finished_at ?? row.started_at,
    kind: 'run',
    category: null,
    level: status === 'failed' ? 'error' : 'info',
    message:
      'run ' + row.trigger + ' → ' + status +
      (row.duration_ms !== null ? ' (' + row.duration_ms + 'ms)' : ''),
    ref: null,
    cost_usd: null,
    details: {
      run_id: row.id,
      runtime_id: row.runtime_id,
      trigger: row.trigger,
      status: row.status,
      duration_ms: row.duration_ms,
      finished_at: row.finished_at,
      error: row.error,
    },
  };
}

// ===========================================================================
// COST PHASE ROLL-UP — derives `phase` from the cost_events.ref
// prefix. Refs follow the convention `<phase>.<rest>` (e.g.
// `codegen.agent.foo.retry.1`, `critique.<file>`, `spec.extract.pass1`).
// Anything we don't recognise lands in `other`.
// ===========================================================================
export function phaseForRef(ref: string | null): ForgeTimelinePhase {
  if (!ref) return 'other';
  const lower = ref.toLowerCase();
  if (lower.includes('.refine') || lower.startsWith('refine')) return 'refine';
  if (lower.includes('.critique') || lower.startsWith('critique'))
    return 'critique';
  if (lower.startsWith('spec.judge') || lower.includes('spec-judge'))
    return 'judge';
  if (lower.startsWith('evals.judge') || lower.includes('.judge'))
    return 'judge';
  if (lower.startsWith('spec.clarification')) return 'clarification';
  if (lower.startsWith('spec.')) return 'spec_extract';
  if (lower.startsWith('codegen.') || lower.startsWith('software.codegen'))
    return 'codegen';
  if (lower.startsWith('system.codegen')) return 'codegen';
  if (lower.startsWith('sandbox')) return 'sandbox';
  if (lower.startsWith('runtime') || lower.startsWith('run.'))
    return 'runtime';
  return 'other';
}

function aggregateCosts(rows: ReadonlyArray<CostEvent>): ForgeTimelinePhaseCosts {
  const acc: ForgeTimelinePhaseCosts = {
    codegen: 0,
    critique: 0,
    refine: 0,
    sandbox: 0,
    runtime: 0,
    spec_extract: 0,
    clarification: 0,
    judge: 0,
    other: 0,
  };
  // Build a mutable copy via index signature so we can accumulate.
  const m = acc as unknown as Record<ForgeTimelinePhase, number>;
  for (const r of rows) {
    const p = phaseForRef(r.ref);
    m[p] += r.amount_usd ?? 0;
  }
  return acc;
}
