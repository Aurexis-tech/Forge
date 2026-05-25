// THE single source of truth for "where is this project in the pipeline?".
//
// Every UI surface — the 3D JourneyPipeline, the 2D fallback stepper, the
// project cards, the agent dashboard — derives its stage state from
// `deriveJourney`. There is no other status logic scattered around.

import type {
  AgentRuntime,
  Build,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';

export type JourneyStageId =
  | 'intent'
  | 'spec'
  | 'plan'
  | 'code'
  | 'sandbox'
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
    case 'pushing':
    case 'pushed':
    case 'push_failed':
    case 'deploying':
    case 'deployed':
    case 'deploy_failed':
    case 'running':
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
