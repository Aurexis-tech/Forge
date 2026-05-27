// THE single source of truth for "where is this project in the pipeline?".
//
// Every UI surface — the 3D JourneyPipeline, the 2D fallback stepper, the
// project cards, the agent dashboard — derives its stage state from
// `deriveJourney`. There is no other status logic scattered around.
//
// Phase 2 (Systems) presentation: `deriveJourney` branches on
// project/spec kind. Agents take the Phase 1 path UNCHANGED (input and
// output bit-identical to before). Systems take a parallel
// `deriveSystemJourney` path that maps the same status enums onto the
// same 8-stage `JourneyStage` shape with two semantic differences:
//
//   - DEPLOY is never skipped for systems. Phase 1 agents skipped
//     deploy when runtime_impl='always_on' / trigger='schedule'; Phase 2
//     systems ALWAYS deploy the orchestrator (P2-5a) before optionally
//     activating a runtime on top.
//   - RUNTIME is OPTIONAL for systems. A deployed system is already
//     live (the deploy URL serves it on-demand); activating the
//     runtime adds scheduled execution. `isLive` for a system flips
//     true at build.status='deployed' OR an active runtime.

import type {
  AgentRuntime,
  Build,
  Plan,
  Project,
  ProjectKind,
  Spec,
} from '@/lib/types';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';
import { InfraSpecSchema, type InfraSpec } from '@/lib/engine/infra/spec';

export type JourneyStageId =
  | 'intent'
  | 'spec'
  | 'plan'
  | 'code'
  | 'sandbox'
  // Software-only ("Database") stage — Phase 3-5a DB provisioning.
  // Lives between sandbox and repo in the software 8-stage shape and
  // is unused by the agent + system derivations.
  | 'provision'
  // Infrastructure-only stages — Phase 4-4 preview ("Preview & cost")
  // and Phase 4-5a/b confirm+apply ("Confirm & apply"). Unused by
  // agent / system / software derivations.
  | 'preview'
  | 'confirm'
  | 'repo'
  | 'deploy'
  | 'runtime';

export type JourneyStageStatus =
  | 'done'
  | 'current'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface JourneyStage {
  id: JourneyStageId;
  // Ordinal 1..8 for stable ordering + chip labels.
  index: number;
  // Short, friendly label.
  label: string;
  // Short status detail for chips / tooltips. Empty string when nothing
  // particularly useful to say.
  detail: string;
  status: JourneyStageStatus;
}

export interface Journey {
  stages: JourneyStage[];
  // The current stage (or the latest done one if everything's complete).
  // Convenience for the UI; equivalent to stages.find(s => s.status === 'current')
  // ?? last done stage.
  cursor: JourneyStage;
  // True when the agent has reached its terminal state — either deployed
  // (on_demand) or has an active runtime (always_on / scheduled).
  isLive: boolean;
  // True when the project's mode routes to the runtime layer instead of
  // the on-demand deploy path.
  isRuntimeMode: boolean;
}

// Compact ordered stage metadata. Index + label are stable; status comes
// from the deriveJourney logic below.
const STAGE_DEFS: Array<{ id: JourneyStageId; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'repo', label: 'Repo' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'runtime', label: 'Live' },
];

export interface DeriveJourneyInput {
  project: Project | null;
  spec: Spec | null;
  plan: Plan | null;
  build: Build | null;
  runtime: AgentRuntime | null;
}

export function deriveJourney(input: DeriveJourneyInput): Journey {
  // Phase 2/3/4 dispatch — system + software + infrastructure
  // projects take parallel derivation paths. Agent projects (the
  // default + every legacy row) fall through to the original Phase 1
  // logic below unchanged.
  const kind = effectiveKind(input);
  if (kind === 'system') {
    return deriveSystemJourney(input);
  }
  if (kind === 'software') {
    return deriveSoftwareJourney(input);
  }
  if (kind === 'infrastructure') {
    return deriveInfraJourney(input);
  }

  const parsedSpec = safeAgentSpec(input.spec);
  const parsedPlan = safeBuildPlan(input.plan);
  const isRuntimeMode = Boolean(
    (parsedPlan && parsedPlan.runtime_impl === 'always_on') ||
      (parsedSpec && parsedSpec.trigger === 'schedule'),
  );

  // Compute each stage independently, then decorate with the cursor.
  const map = new Map<JourneyStageId, JourneyStage>();

  // --- intent -------------------------------------------------------------
  map.set('intent', {
    id: 'intent',
    index: 1,
    label: 'Intent',
    detail: input.project ? truncate(input.project.name, 32) : '—',
    status: input.project ? 'done' : 'current',
  });

  // --- spec ---------------------------------------------------------------
  map.set('spec', specStage(input.spec));

  // --- plan ---------------------------------------------------------------
  map.set('plan', planStage(input.spec, input.plan));

  // --- code ---------------------------------------------------------------
  map.set('code', codeStage(input.plan, input.build));

  // --- sandbox ------------------------------------------------------------
  map.set('sandbox', sandboxStage(input.build));

  // --- repo ---------------------------------------------------------------
  map.set('repo', repoStage(input.build));

  // --- deploy -------------------------------------------------------------
  map.set('deploy', deployStage(input.build, isRuntimeMode));

  // --- runtime / live -----------------------------------------------------
  map.set('runtime', runtimeStage(input.build, input.runtime, isRuntimeMode));

  const stages = STAGE_DEFS.map((def, i) => {
    const stage = map.get(def.id)!;
    return { ...stage, index: i + 1, label: def.label };
  });

  // Resolve the cursor. Only ONE stage gets 'current'; everything later
  // becomes 'pending', everything earlier stays 'done' (or 'failed'/'skipped').
  const explicitCurrent = stages.findIndex((s) => s.status === 'current');
  const lastDone = lastIndexWhere(stages, (s) => s.status === 'done');
  const failed = stages.findIndex((s) => s.status === 'failed');

  if (failed >= 0) {
    // A failure short-circuits — the failed stage IS where the user lives.
    for (let i = failed + 1; i < stages.length; i++) {
      if (stages[i]!.status === 'current') stages[i]!.status = 'pending';
    }
  } else if (explicitCurrent < 0 && lastDone < stages.length - 1) {
    // Nothing explicit — the next stage after the last done one is current.
    const idx = lastDone + 1;
    if (stages[idx]) stages[idx]!.status = 'current';
  }

  const cursor =
    stages.find((s) => s.status === 'current') ??
    stages[lastIndexWhere(stages, (s) => s.status === 'done') ?? 0] ??
    stages[0]!;

  const isLive =
    (!isRuntimeMode && input.build?.status === 'deployed') ||
    (isRuntimeMode &&
      input.runtime != null &&
      (input.runtime.status === 'active' || input.runtime.status === 'paused'));

  return { stages, cursor, isLive, isRuntimeMode };
}

// --- individual stage derivations -----------------------------------------

function specStage(spec: Spec | null): JourneyStage {
  if (!spec) {
    return base('spec', 'Spec', 'pending', '');
  }
  switch (spec.status) {
    case 'pending':
      return base('spec', 'Spec', 'current', 'waiting to extract');
    case 'extracting':
      return base('spec', 'Spec', 'current', 'extracting…');
    case 'needs_clarification':
      return base('spec', 'Spec', 'current', 'needs clarification');
    case 'awaiting_review':
      return base('spec', 'Spec', 'current', 'awaiting review');
    case 'confirmed':
      return base('spec', 'Spec', 'done', 'confirmed');
    case 'failed':
      return base('spec', 'Spec', 'failed', 'extraction failed');
    default:
      return base('spec', 'Spec', 'current', spec.status);
  }
}

function planStage(spec: Spec | null, plan: Plan | null): JourneyStage {
  if (!spec || spec.status !== 'confirmed') {
    return base('plan', 'Plan', 'pending', '');
  }
  if (!plan) return base('plan', 'Plan', 'current', 'ready to plan');
  switch (plan.status) {
    case 'pending':
      return base('plan', 'Plan', 'current', 'pending');
    case 'planning':
      return base('plan', 'Plan', 'current', 'planning…');
    case 'awaiting_review':
      return base('plan', 'Plan', 'current', 'awaiting approval');
    case 'approved':
      return base('plan', 'Plan', 'done', 'approved');
    case 'failed':
      return base('plan', 'Plan', 'failed', 'planning failed');
    default:
      return base('plan', 'Plan', 'current', plan.status);
  }
}

function codeStage(plan: Plan | null, build: Build | null): JourneyStage {
  if (!plan || plan.status !== 'approved') {
    return base('code', 'Code', 'pending', '');
  }
  if (!build) return base('code', 'Code', 'current', 'ready to generate');
  switch (build.status) {
    case 'queued':
      return base('code', 'Code', 'current', 'queued');
    case 'generating':
      return base('code', 'Code', 'current', 'generating…');
    case 'generated':
    case 'testing':
    case 'tested':
    case 'test_failed':
    // Phase 3 (software) lifecycle states — all imply codegen is
    // already done. Agent + system builds never reach these statuses,
    // so this addition leaves their derivations bit-identical.
    case 'provisioning':
    case 'provisioned':
    case 'provision_failed':
    case 'pushing':
    case 'pushed':
    case 'push_failed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
    // Phase 4 (infra) lifecycle states — all imply codegen is done.
    // Agent / system / software builds never reach these, so adding
    // them here leaves the other derivations bit-identical.
    case 'previewing':
    case 'previewed':
    case 'preview_blocked':
    case 'planning':
    case 'plan_confirmed':
    case 'plan_blocked':
    case 'applying':
    case 'apply_failed':
    case 'destroying':
    case 'destroyed':
      return base('code', 'Code', 'done', 'generated');
    case 'failed':
      return base('code', 'Code', 'failed', 'codegen failed');
    default:
      return base('code', 'Code', 'current', String(build.status));
  }
}

function sandboxStage(build: Build | null): JourneyStage {
  if (!build || build.status === 'queued' || build.status === 'generating') {
    return base('sandbox', 'Sandbox', 'pending', '');
  }
  switch (build.status) {
    case 'generated':
      return base('sandbox', 'Sandbox', 'current', 'ready to test');
    case 'testing':
      return base('sandbox', 'Sandbox', 'current', 'sealed chamber running');
    case 'tested':
    case 'pushing':
    case 'pushed':
    case 'push_failed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
      return base('sandbox', 'Sandbox', 'done', 'tested');
    case 'test_failed':
      return base('sandbox', 'Sandbox', 'failed', 'test failed');
    default:
      return base('sandbox', 'Sandbox', 'pending', '');
  }
}

function repoStage(build: Build | null): JourneyStage {
  if (
    !build ||
    build.status === 'queued' ||
    build.status === 'generating' ||
    build.status === 'generated' ||
    build.status === 'testing' ||
    build.status === 'test_failed'
  ) {
    return base('repo', 'Repo', 'pending', '');
  }
  switch (build.status) {
    case 'tested':
      return base('repo', 'Repo', 'current', 'ready to push');
    case 'pushing':
      return base('repo', 'Repo', 'current', 'pushing…');
    case 'pushed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
      return base('repo', 'Repo', 'done', build.repo_url ? short(build.repo_url) : 'pushed');
    case 'push_failed':
      return base('repo', 'Repo', 'failed', 'push failed');
    default:
      return base('repo', 'Repo', 'pending', '');
  }
}

function deployStage(build: Build | null, isRuntimeMode: boolean): JourneyStage {
  if (isRuntimeMode) {
    // The runtime mode SKIPS Vercel deploy entirely.
    return base('deploy', 'Deploy', 'skipped', 'routed to runtime');
  }
  if (
    !build ||
    !['pushed', 'deploying', 'deployed', 'deploy_failed', 'running'].includes(build.status)
  ) {
    return base('deploy', 'Deploy', 'pending', '');
  }
  switch (build.status) {
    case 'pushed':
      return base('deploy', 'Deploy', 'current', 'awaiting authorisation');
    case 'deploying':
      return base('deploy', 'Deploy', 'current', 'deploying…');
    case 'deployed':
      return base('deploy', 'Deploy', 'done', build.deploy_url ? short(build.deploy_url) : 'live');
    case 'deploy_failed':
      return base('deploy', 'Deploy', 'failed', 'deploy failed');
    default:
      return base('deploy', 'Deploy', 'pending', '');
  }
}

function runtimeStage(
  build: Build | null,
  runtime: AgentRuntime | null,
  isRuntimeMode: boolean,
): JourneyStage {
  if (!isRuntimeMode) {
    // On-demand mode — "Live" = deployed.
    if (build?.status === 'deployed') {
      return base('runtime', 'Live', 'done', 'on-demand · live');
    }
    if (build?.status === 'deploy_failed') {
      return base('runtime', 'Live', 'blocked', 'deploy first');
    }
    return base('runtime', 'Live', 'pending', '');
  }
  // Runtime mode.
  if (!runtime || runtime.status === 'stopped') {
    if (build?.status === 'pushed' || build?.status === 'running') {
      return base('runtime', 'Live', 'current', 'awaiting activation');
    }
    return base('runtime', 'Live', 'pending', '');
  }
  switch (runtime.status) {
    case 'active':
      return base(
        'runtime',
        'Live',
        'done',
        'active · ' + runtime.run_count + ' runs',
      );
    case 'paused':
      return base('runtime', 'Live', 'done', 'paused');
    case 'errored':
      return base('runtime', 'Live', 'failed', 'auto-paused');
    default:
      return base('runtime', 'Live', 'current', String(runtime.status));
  }
}

// --- helpers ---------------------------------------------------------------

function base(
  id: JourneyStageId,
  label: string,
  status: JourneyStageStatus,
  detail: string,
): JourneyStage {
  return { id, label, status, detail, index: 0 };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function short(url: string): string {
  return url.replace(/^https?:\/\//, '').slice(0, 40);
}

function lastIndexWhere<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

function safeAgentSpec(spec: Spec | null): AgentSpec | null {
  if (!spec || !spec.structured_spec) return null;
  const parsed = AgentSpecSchema.safeParse(spec.structured_spec);
  return parsed.success ? parsed.data : null;
}

function safeBuildPlan(plan: Plan | null): BuildPlan | null {
  if (!plan || !plan.plan) return null;
  const parsed = BuildPlanSchema.safeParse(plan.plan);
  return parsed.success ? parsed.data : null;
}

function safeSystemSpec(spec: Spec | null): SystemSpec | null {
  if (!spec || !spec.structured_spec) return null;
  const parsed = SystemSpecSchema.safeParse(spec.structured_spec);
  return parsed.success ? parsed.data : null;
}

// Resolve the effective project kind. Falls back to 'agent' so a
// legacy row without `kind` keeps the Phase 1 behaviour (the column
// was added in P2 with default 'agent', so this is only relevant for
// tests / hand-crafted rows).
function effectiveKind(input: DeriveJourneyInput): ProjectKind | string {
  return input.project?.kind ?? input.spec?.kind ?? 'agent';
}

// ---------------------------------------------------------------------------
// Phase 2 (Systems) journey derivation.
//
// Same 8-stage shape, same statuses, same cursor resolution as the
// agent path — only the deploy + runtime semantics diverge:
//   - Systems ALWAYS deploy (never skipped).
//   - Systems are "live" at deployed; runtime activation is a
//     scheduled add-on, not a replacement for deploy.
// ---------------------------------------------------------------------------

function deriveSystemJourney(input: DeriveJourneyInput): Journey {
  const parsedSpec = safeSystemSpec(input.spec);
  // For systems, "runtime mode" means a system runtime has been
  // activated (or is currently configured). The SystemSpec.triggers
  // declare INTENT (the system was DESIGNED to run on a schedule),
  // but the runtime row is the ground truth at any given moment.
  const declaresSchedule = Boolean(
    parsedSpec && parsedSpec.triggers.includes('schedule'),
  );
  const hasConfiguredRuntime = Boolean(
    input.runtime && input.runtime.status !== 'stopped',
  );
  const isRuntimeMode = declaresSchedule || hasConfiguredRuntime;

  const map = new Map<JourneyStageId, JourneyStage>();

  // intent / spec / plan / code / sandbox / repo — identical to the
  // agent derivation. The status enums on specs / plans / builds are
  // shared between kinds, so the same per-stage functions Just Work
  // (the spec parser is agent-only, but the spec.status check on
  // those functions doesn't reach into structured_spec).
  map.set('intent', {
    id: 'intent',
    index: 1,
    label: 'Intent',
    detail: input.project ? truncate(input.project.name, 32) : '—',
    status: input.project ? 'done' : 'current',
  });
  map.set('spec', specStage(input.spec));
  map.set('plan', planStage(input.spec, input.plan));
  map.set('code', codeStage(input.plan, input.build));
  map.set('sandbox', sandboxStage(input.build));
  map.set('repo', repoStage(input.build));

  // --- deploy (system-specific: NEVER skipped) ---------------------------
  map.set('deploy', systemDeployStage(input.build));

  // --- runtime (system-specific: optional layer on top of deploy) --------
  map.set('runtime', systemRuntimeStage(input.build, input.runtime));

  const stages = STAGE_DEFS.map((def, i) => {
    const stage = map.get(def.id)!;
    return { ...stage, index: i + 1, label: def.label };
  });

  // Same cursor + failed-stage short-circuit logic as the agent path.
  const explicitCurrent = stages.findIndex((s) => s.status === 'current');
  const lastDone = lastIndexWhere(stages, (s) => s.status === 'done');
  const failed = stages.findIndex((s) => s.status === 'failed');

  if (failed >= 0) {
    for (let i = failed + 1; i < stages.length; i++) {
      if (stages[i]!.status === 'current') stages[i]!.status = 'pending';
    }
  } else if (explicitCurrent < 0 && lastDone < stages.length - 1) {
    const idx = lastDone + 1;
    if (stages[idx]) stages[idx]!.status = 'current';
  }

  const cursor =
    stages.find((s) => s.status === 'current') ??
    stages[lastIndexWhere(stages, (s) => s.status === 'done') ?? 0] ??
    stages[0]!;

  // A system is "live" at deployed (the URL is reachable) OR when a
  // runtime is active/paused. Note: build.status === 'running' implies
  // a runtime exists, so it's covered by the runtime side of the OR.
  const isLive =
    input.build?.status === 'deployed' ||
    input.build?.status === 'running' ||
    (input.runtime != null &&
      (input.runtime.status === 'active' || input.runtime.status === 'paused'));

  return { stages, cursor, isLive, isRuntimeMode };
}

function systemDeployStage(build: Build | null): JourneyStage {
  // Pre-deploy states keep deploy pending. We never SKIP deploy for
  // systems — the orchestrator must be deployed before the runtime
  // can activate.
  if (
    !build ||
    !['pushed', 'deploying', 'deployed', 'deploy_failed', 'running'].includes(
      build.status,
    )
  ) {
    return base('deploy', 'Deploy', 'pending', '');
  }
  switch (build.status) {
    case 'pushed':
      return base('deploy', 'Deploy', 'current', 'awaiting authorisation');
    case 'deploying':
      return base('deploy', 'Deploy', 'current', 'deploying…');
    case 'deployed':
    case 'running':
      return base(
        'deploy',
        'Deploy',
        'done',
        build.deploy_url ? short(build.deploy_url) : 'live',
      );
    case 'deploy_failed':
      return base('deploy', 'Deploy', 'failed', 'deploy failed');
    default:
      return base('deploy', 'Deploy', 'pending', '');
  }
}

function systemRuntimeStage(
  build: Build | null,
  runtime: AgentRuntime | null,
): JourneyStage {
  // Pre-deploy → runtime is pending (deploy must finish first).
  if (
    !build ||
    !['deployed', 'deploy_failed', 'running'].includes(build.status)
  ) {
    return base('runtime', 'Live', 'pending', '');
  }
  if (build.status === 'deploy_failed') {
    return base('runtime', 'Live', 'blocked', 'deploy first');
  }

  // 'deployed' with no active runtime → the system is live on-demand
  // (the deploy URL serves it), and activation is the next user
  // action. We surface this as 'done' so the journey reads as live —
  // the cursor still advances to 'runtime' so the activation panel
  // mounts on the project page.
  if (!runtime || runtime.status === 'stopped') {
    if (build.status === 'deployed') {
      return base('runtime', 'Live', 'done', 'on-demand · live');
    }
    return base('runtime', 'Live', 'current', 'awaiting activation');
  }

  switch (runtime.status) {
    case 'active':
      return base(
        'runtime',
        'Live',
        'done',
        'active · ' + runtime.run_count + ' runs',
      );
    case 'paused':
      return base('runtime', 'Live', 'done', 'paused');
    case 'errored':
      return base('runtime', 'Live', 'failed', 'auto-paused');
    default:
      return base('runtime', 'Live', 'current', String(runtime.status));
  }
}

// ---------------------------------------------------------------------------
// Phase 3 (Software) journey derivation.
//
// Same 8-stage cursor/status/journey shape as agent + system, but the
// stage map replaces 'repo' with 'provision' (Phase 3-5a DB step).
// 'deploy' covers push + deploy together — software pushes to GitHub
// and immediately deploys to Vercel in P3-5b, and the user reads it
// as one beat.
//
// AGENT + SYSTEM journeys remain bit-identical — software gets its
// own STAGE_DEFS array and its own per-stage derivations; nothing in
// the agent/system code paths reads from this section.
// ---------------------------------------------------------------------------

const SOFTWARE_STAGE_DEFS: Array<{ id: JourneyStageId; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'provision', label: 'Database' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'runtime', label: 'Live' },
];

function deriveSoftwareJourney(input: DeriveJourneyInput): Journey {
  // For software, "runtime mode" is meaningless — a deployed web app
  // is always serving (not scheduled). We surface isRuntimeMode=false
  // so downstream UI doesn't mis-categorise it as scheduled.
  const isRuntimeMode = false;

  const map = new Map<JourneyStageId, JourneyStage>();

  map.set('intent', {
    id: 'intent',
    index: 1,
    label: 'Intent',
    detail: input.project ? truncate(input.project.name, 32) : '—',
    status: input.project ? 'done' : 'current',
  });
  map.set('spec', specStage(input.spec));
  map.set('plan', planStage(input.spec, input.plan));
  map.set('code', codeStage(input.plan, input.build));
  map.set('sandbox', softwareSandboxStage(input.build));
  map.set('provision', softwareProvisionStage(input.build));
  map.set('deploy', softwareDeployStage(input.build));
  map.set('runtime', softwareRuntimeStage(input.build, input.runtime));

  const stages = SOFTWARE_STAGE_DEFS.map((def, i) => {
    const stage = map.get(def.id)!;
    return { ...stage, index: i + 1, label: def.label };
  });

  const explicitCurrent = stages.findIndex((s) => s.status === 'current');
  const lastDone = lastIndexWhere(stages, (s) => s.status === 'done');
  const failed = stages.findIndex((s) => s.status === 'failed');

  if (failed >= 0) {
    for (let i = failed + 1; i < stages.length; i++) {
      if (stages[i]!.status === 'current') stages[i]!.status = 'pending';
    }
  } else if (explicitCurrent < 0 && lastDone < stages.length - 1) {
    const idx = lastDone + 1;
    if (stages[idx]) stages[idx]!.status = 'current';
  }

  const cursor =
    stages.find((s) => s.status === 'current') ??
    stages[lastIndexWhere(stages, (s) => s.status === 'done') ?? 0] ??
    stages[0]!;

  // A software app is "live" once its software runtime row reaches
  // 'active' (or 'paused' — paused-by-killswitch still counts as a
  // configured, governable live runtime, just temporarily offline).
  const isLive =
    input.runtime != null &&
    input.runtime.kind === 'software' &&
    (input.runtime.status === 'active' ||
      input.runtime.status === 'paused');

  return { stages, cursor, isLive, isRuntimeMode };
}

function softwareSandboxStage(build: Build | null): JourneyStage {
  if (!build || build.status === 'queued' || build.status === 'generating') {
    return base('sandbox', 'Sandbox', 'pending', '');
  }
  switch (build.status) {
    case 'generated':
      return base('sandbox', 'Sandbox', 'current', 'ready to test');
    case 'testing':
      return base('sandbox', 'Sandbox', 'current', 'sealed chamber running');
    case 'tested':
    case 'provisioning':
    case 'provisioned':
    case 'provision_failed':
    case 'pushing':
    case 'pushed':
    case 'push_failed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
      return base('sandbox', 'Sandbox', 'done', 'isolation passed');
    case 'test_failed':
      return base('sandbox', 'Sandbox', 'failed', 'isolation failed');
    default:
      return base('sandbox', 'Sandbox', 'pending', '');
  }
}

function softwareProvisionStage(build: Build | null): JourneyStage {
  if (
    !build ||
    build.status === 'queued' ||
    build.status === 'generating' ||
    build.status === 'generated' ||
    build.status === 'testing' ||
    build.status === 'test_failed'
  ) {
    return base('provision', 'Database', 'pending', '');
  }
  switch (build.status) {
    case 'tested':
      return base('provision', 'Database', 'current', 'awaiting provision');
    case 'provisioning':
      return base('provision', 'Database', 'current', 'provisioning…');
    case 'provisioned':
    case 'pushing':
    case 'pushed':
    case 'push_failed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
      return base('provision', 'Database', 'done', 'schema applied ✓');
    case 'provision_failed':
      return base('provision', 'Database', 'failed', 'provision failed');
    default:
      return base('provision', 'Database', 'pending', '');
  }
}

function softwareDeployStage(build: Build | null): JourneyStage {
  if (
    !build ||
    !['provisioned', 'pushing', 'pushed', 'push_failed', 'deploying', 'deployed', 'deploy_failed', 'running'].includes(
      build.status,
    )
  ) {
    return base('deploy', 'Deploy', 'pending', '');
  }
  switch (build.status) {
    case 'provisioned':
      return base('deploy', 'Deploy', 'current', 'awaiting push');
    case 'pushing':
      return base('deploy', 'Deploy', 'current', 'pushing…');
    case 'pushed':
      return base('deploy', 'Deploy', 'current', 'awaiting deploy');
    case 'push_failed':
      return base('deploy', 'Deploy', 'failed', 'push failed');
    case 'deploying':
      return base('deploy', 'Deploy', 'current', 'deploying…');
    case 'deployed':
    case 'running':
      return base(
        'deploy',
        'Deploy',
        'done',
        build.deploy_url ? short(build.deploy_url) : 'live',
      );
    case 'deploy_failed':
      return base('deploy', 'Deploy', 'failed', 'deploy failed');
    default:
      return base('deploy', 'Deploy', 'pending', '');
  }
}

function softwareRuntimeStage(
  build: Build | null,
  runtime: AgentRuntime | null,
): JourneyStage {
  if (
    !build ||
    !['deployed', 'deploy_failed', 'running'].includes(build.status)
  ) {
    return base('runtime', 'Live', 'pending', '');
  }
  if (build.status === 'deploy_failed') {
    return base('runtime', 'Live', 'blocked', 'deploy first');
  }
  if (!runtime || runtime.kind !== 'software' || runtime.status === 'stopped') {
    return base('runtime', 'Live', 'current', 'awaiting go-live');
  }
  switch (runtime.status) {
    case 'active':
      return base('runtime', 'Live', 'done', 'live');
    case 'paused':
      // Paused on a software runtime almost always means the kill
      // switch took the app offline. Surface as 'failed' so the
      // journey reads as not-live + needs attention.
      return base('runtime', 'Live', 'failed', 'offline · paused');
    case 'errored':
      return base('runtime', 'Live', 'failed', 'errored');
    default:
      return base('runtime', 'Live', 'current', String(runtime.status));
  }
}

// Resolve the software spec defensively so dashboards can show a
// plain-language summary without the route handler doing it.
export function safeSoftwareSpec(spec: Spec | null): SoftwareSpec | null {
  if (!spec || !spec.structured_spec) return null;
  const parsed = SoftwareSpecSchema.safeParse(spec.structured_spec);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Phase 4 (Infrastructure) journey derivation.
//
// 8-stage shape, mirroring agent/system/software:
//   1. intent           — intake
//   2. spec             — InfraSpec confirmed
//   3. plan             — ProvisioningPlan approved
//   4. code             — IaC codegen (P4-3)
//   5. preview          — Cost preview + ceiling (P4-4)
//   6. confirm          — Real plan + typed-confirm (P4-5a)
//   7. deploy           — Apply to real cloud (P4-5b) — the ONLY
//                         real-cloud write
//   8. runtime          — Monitored (live) / destroyed
//
// AGENT + SYSTEM + SOFTWARE journeys remain bit-identical — infra
// gets its own STAGE_DEFS array and per-stage derivations; nothing in
// the agent/system/software code paths reads from this section.
// ---------------------------------------------------------------------------

const INFRA_STAGE_DEFS: Array<{ id: JourneyStageId; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'IaC' },
  { id: 'preview', label: 'Preview' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'deploy', label: 'Apply' },
  { id: 'runtime', label: 'Live' },
];

function deriveInfraJourney(input: DeriveJourneyInput): Journey {
  // Infra never has a "scheduled vs always-on" semantic — provisioned
  // resources just exist. isRuntimeMode surfaces false so downstream
  // UI doesn't mis-categorise.
  const isRuntimeMode = false;

  const map = new Map<JourneyStageId, JourneyStage>();

  map.set('intent', {
    id: 'intent',
    index: 1,
    label: 'Intent',
    detail: input.project ? truncate(input.project.name, 32) : '—',
    status: input.project ? 'done' : 'current',
  });
  map.set('spec', specStage(input.spec));
  map.set('plan', planStage(input.spec, input.plan));
  map.set('code', codeStage(input.plan, input.build));
  map.set('preview', infraPreviewStage(input.build));
  map.set('confirm', infraConfirmStage(input.build));
  map.set('deploy', infraDeployStage(input.build));
  map.set('runtime', infraRuntimeStage(input.build));

  const stages = INFRA_STAGE_DEFS.map((def, i) => {
    const stage = map.get(def.id)!;
    return { ...stage, index: i + 1, label: def.label };
  });

  const explicitCurrent = stages.findIndex((s) => s.status === 'current');
  const lastDone = lastIndexWhere(stages, (s) => s.status === 'done');
  const failed = stages.findIndex((s) => s.status === 'failed');

  if (failed >= 0) {
    for (let i = failed + 1; i < stages.length; i++) {
      if (stages[i]!.status === 'current') stages[i]!.status = 'pending';
    }
  } else if (explicitCurrent < 0 && lastDone < stages.length - 1) {
    const idx = lastDone + 1;
    if (stages[idx]) stages[idx]!.status = 'current';
  }

  const cursor =
    stages.find((s) => s.status === 'current') ??
    stages[lastIndexWhere(stages, (s) => s.status === 'done') ?? 0] ??
    stages[0]!;

  // An infra build is "live" once it has reached 'provisioned'.
  // 'destroyed' explicitly is NOT live. 'apply_failed' is not live
  // either — partial state may exist but the deployment didn't
  // complete.
  const isLive = input.build?.status === 'provisioned';

  return { stages, cursor, isLive, isRuntimeMode };
}

function infraPreviewStage(build: Build | null): JourneyStage {
  if (
    !build ||
    build.status === 'queued' ||
    build.status === 'generating' ||
    build.status === 'failed'
  ) {
    return base('preview', 'Preview', 'pending', '');
  }
  switch (build.status) {
    case 'generated':
      return base('preview', 'Preview', 'current', 'awaiting preview');
    case 'previewing':
      return base('preview', 'Preview', 'current', 'previewing…');
    case 'preview_blocked':
      return base('preview', 'Preview', 'failed', 'over budget');
    case 'previewed':
    case 'planning':
    case 'plan_confirmed':
    case 'plan_blocked':
    case 'applying':
    case 'provisioned':
    case 'apply_failed':
    case 'destroying':
    case 'destroyed':
    case 'running':
      return base('preview', 'Preview', 'done', 'within budget');
    default:
      return base('preview', 'Preview', 'pending', '');
  }
}

function infraConfirmStage(build: Build | null): JourneyStage {
  // The 'confirm' stage covers the P4-5a real-plan + typed-confirm
  // gate. Live until 'plan_confirmed' (or until apply has fired).
  if (
    !build ||
    !['previewed', 'planning', 'plan_confirmed', 'plan_blocked', 'applying', 'provisioned', 'apply_failed', 'destroying', 'destroyed', 'running'].includes(
      build.status,
    )
  ) {
    return base('confirm', 'Confirm', 'pending', '');
  }
  switch (build.status) {
    case 'previewed':
      return base('confirm', 'Confirm', 'current', 'awaiting real plan');
    case 'planning':
      return base('confirm', 'Confirm', 'current', 'real plan in flight');
    case 'plan_blocked':
      return base('confirm', 'Confirm', 'failed', 'over budget on real plan');
    case 'plan_confirmed':
    case 'applying':
    case 'provisioned':
    case 'apply_failed':
    case 'destroying':
    case 'destroyed':
    case 'running':
      return base('confirm', 'Confirm', 'done', 'plan confirmed');
    default:
      return base('confirm', 'Confirm', 'pending', '');
  }
}

function infraDeployStage(build: Build | null): JourneyStage {
  // The 'deploy' stage covers the P4-5b apply (the only real-cloud
  // write). Failure here is destructive — partial state may exist
  // even though the apply didn't complete.
  if (
    !build ||
    !['plan_confirmed', 'applying', 'provisioned', 'apply_failed', 'destroying', 'destroyed', 'running'].includes(
      build.status,
    )
  ) {
    return base('deploy', 'Apply', 'pending', '');
  }
  switch (build.status) {
    case 'plan_confirmed':
      return base('deploy', 'Apply', 'current', 'awaiting apply');
    case 'applying':
      return base('deploy', 'Apply', 'current', 'applying to real cloud…');
    case 'apply_failed':
      return base('deploy', 'Apply', 'failed', 'apply failed · partial state');
    case 'provisioned':
    case 'destroying':
    case 'destroyed':
    case 'running':
      return base('deploy', 'Apply', 'done', 'provisioned');
    default:
      return base('deploy', 'Apply', 'pending', '');
  }
}

function infraRuntimeStage(build: Build | null): JourneyStage {
  if (
    !build ||
    !['provisioned', 'destroying', 'destroyed'].includes(build.status)
  ) {
    return base('runtime', 'Live', 'pending', '');
  }
  switch (build.status) {
    case 'provisioned':
      return base('runtime', 'Live', 'done', 'monitored');
    case 'destroying':
      return base('runtime', 'Live', 'current', 'tearing down…');
    case 'destroyed':
      // Destroyed is a terminal state. Surface as 'done' with the
      // explicit detail so the journey reads as "complete →
      // destroyed". isLive is computed separately and is FALSE for
      // 'destroyed' — the dashboard handles the explicit copy.
      return base('runtime', 'Live', 'done', 'destroyed');
    default:
      return base('runtime', 'Live', 'pending', '');
  }
}

// Resolve the infra spec defensively so dashboards can show a
// plain-language summary without the route handler doing it.
export function safeInfraSpec(spec: Spec | null): InfraSpec | null {
  if (!spec || !spec.structured_spec) return null;
  const parsed = InfraSpecSchema.safeParse(spec.structured_spec);
  return parsed.success ? parsed.data : null;
}
