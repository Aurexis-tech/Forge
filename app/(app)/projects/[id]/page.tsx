import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GlassPanel } from '@/components/GlassPanel';
import { GenerateBuildPanel } from '@/components/build/GenerateBuildPanel';
import { GeneratedBuildPanel } from '@/components/build/GeneratedBuildPanel';
import type { StaticStatus } from '@/components/build/FileTree';
import { ApprovedPlanPanel } from '@/components/plan/ApprovedPlanPanel';
import { GeneratePlanPanel } from '@/components/plan/GeneratePlanPanel';
import { ReviewPlanPanel } from '@/components/plan/ReviewPlanPanel';
import { ConnectGitHubPanel } from '@/components/github/ConnectGitHubPanel';
import { GitHubPushPanel } from '@/components/github/GitHubPushPanel';
import { PushedPanel } from '@/components/github/PushedPanel';
import { PushFailedPanel } from '@/components/github/PushFailedPanel';
import { ConnectVercelPanel } from '@/components/vercel/ConnectVercelPanel';
import { DeployBlockedPanel } from '@/components/vercel/DeployBlockedPanel';
import { DeployedPanel } from '@/components/vercel/DeployedPanel';
import { DeployFailedPanel } from '@/components/vercel/DeployFailedPanel';
import { DeployFlow } from '@/components/vercel/DeployFlow';
import { AgentDashboard } from '@/components/dashboard/AgentDashboard';
import { JourneyBridge } from '@/components/journey/JourneyBridge';
import { JourneyOverlay } from '@/components/journey/JourneyOverlay';
import { ActivateRuntimeFlow } from '@/components/runtime/ActivateRuntimeFlow';
import { RuntimeView } from '@/components/runtime/RuntimeView';
import { RunTestPanel } from '@/components/sandbox/RunTestPanel';
import { TestedPanel } from '@/components/sandbox/TestedPanel';
import { TestFailedPanel } from '@/components/sandbox/TestFailedPanel';
import type { PhaseStatus } from '@/components/sandbox/TestView';
import { ClarificationPanel } from '@/components/spec/ClarificationPanel';
import { ConfirmedPanel } from '@/components/spec/ConfirmedPanel';
import { GenerateSpecPanel } from '@/components/spec/GenerateSpecPanel';
import { ReviewPanel } from '@/components/spec/ReviewPanel';
import { SystemConfirmedPanel } from '@/components/spec/SystemConfirmedPanel';
import { SystemReviewPanel } from '@/components/spec/SystemReviewPanel';
import { ApprovedOrchestrationPanel } from '@/components/system/ApprovedOrchestrationPanel';
import { GenerateOrchestrationPanel } from '@/components/system/GenerateOrchestrationPanel';
import { ReviewOrchestrationPanel } from '@/components/system/ReviewOrchestrationPanel';
import { GenerateSystemBuildPanel } from '@/components/system/GenerateSystemBuildPanel';
import { SystemBuildView } from '@/components/system/SystemBuildView';
import { TestSystemBuildPanel } from '@/components/system/TestSystemBuildPanel';
import { SystemTestView } from '@/components/system/SystemTestView';
import { SystemGitHubPushPanel } from '@/components/system/SystemGitHubPushPanel';
import { SystemDeployFlow } from '@/components/system/SystemDeployFlow';
import { SystemActivateRuntimeFlow } from '@/components/system/SystemActivateRuntimeFlow';
import { SystemRuntimePanel } from '@/components/system/SystemRuntimePanel';
import { SystemGraphView } from '@/components/system/SystemGraphView';
import { aggregateSystemEnvRequired } from '@/lib/engine/system/integrations/persistence';
import { OrchestrationPlanSchema } from '@/lib/engine/system/planner/schema';
import { SystemSpecSchema } from '@/lib/engine/system/spec';
import { SoftwareConfirmedPanel } from '@/components/software/SoftwareConfirmedPanel';
import { SoftwareReviewPanel } from '@/components/software/SoftwareReviewPanel';
import { ApprovedSoftwarePlanPanel } from '@/components/software/ApprovedSoftwarePlanPanel';
import { GenerateSoftwarePlanPanel } from '@/components/software/GenerateSoftwarePlanPanel';
import { ReviewSoftwarePlanPanel } from '@/components/software/ReviewSoftwarePlanPanel';
import { GenerateSoftwareBuildPanel } from '@/components/software/GenerateSoftwareBuildPanel';
import { ProvisionDbFlow } from '@/components/software/ProvisionDbFlow';
import { ProvisionedDbPanel } from '@/components/software/ProvisionedDbPanel';
import { SoftwareActivateRuntimeFlow } from '@/components/software/SoftwareActivateRuntimeFlow';
import { SoftwareAppDashboard } from '@/components/software/SoftwareAppDashboard';
import { SoftwareBuildView } from '@/components/software/SoftwareBuildView';
import { SoftwareDeployedPanel } from '@/components/software/SoftwareDeployedPanel';
import { SoftwareDeployFlow } from '@/components/software/SoftwareDeployFlow';
import { SoftwareGitHubPushPanel } from '@/components/software/SoftwareGitHubPushPanel';
import { TestSoftwareBuildPanel } from '@/components/software/TestSoftwareBuildPanel';
import { SoftwareTestView } from '@/components/software/SoftwareTestView';
import { loadLatestSoftwareDatabase, sanitizeDbForResponse, type PublicSoftwareDatabase } from '@/lib/engine/software/db/persistence';
import {
  assembleSoftwareDashboard,
  loadSoftwareRuntimeForProject,
  syncSoftwareRuntimeWithKillSwitch,
  type SoftwareDashboardPayload,
} from '@/lib/engine/software/runtime/persistence';
import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import { SoftwareBuildPlanSchema } from '@/lib/engine/software/planner/schema';
import { SoftwareSpecSchema } from '@/lib/engine/software/spec';
import { InfraConfirmedPanel } from '@/components/infra/InfraConfirmedPanel';
import { InfraReviewPanel } from '@/components/infra/InfraReviewPanel';
import { ApprovedInfraPlanPanel } from '@/components/infra/ApprovedInfraPlanPanel';
import { GenerateInfraPlanPanel } from '@/components/infra/GenerateInfraPlanPanel';
import { ReviewInfraPlanPanel } from '@/components/infra/ReviewInfraPlanPanel';
import { GenerateInfraBuildPanel } from '@/components/infra/GenerateInfraBuildPanel';
import { InfraBuildView } from '@/components/infra/InfraBuildView';
import { InfraConfirmPlanFlow } from '@/components/infra/InfraConfirmPlanFlow';
import { InfraPlanView } from '@/components/infra/InfraPlanView';
import { InfraPreviewPanel } from '@/components/infra/InfraPreviewPanel';
import { InfraPreviewView } from '@/components/infra/InfraPreviewView';
import { RunInfraPlanPanel } from '@/components/infra/RunInfraPlanPanel';
import {
  loadLatestInfraPreview,
  sanitizeInfraPreviewForResponse,
  type PublicInfraPreview,
} from '@/lib/engine/infra/preview/persistence';
import {
  loadLatestInfraPlanRow,
  sanitizeInfraPlanForResponse,
  type PublicInfraPlan,
} from '@/lib/engine/infra/cloud/persistence';
import {
  loadLatestInfraApply,
  sanitizeInfraApplyForResponse,
  type PublicInfraApply,
} from '@/lib/engine/infra/cloud/apply-persistence';
import { ApplyFailedPanel } from '@/components/infra/ApplyFailedPanel';
import { ApplyInfraPanel } from '@/components/infra/ApplyInfraPanel';
import { InfraMonitorDashboard } from '@/components/infra/InfraMonitorDashboard';
import { InfraProvisionedPanel } from '@/components/infra/InfraProvisionedPanel';
import {
  assembleInfraDashboard,
  loadLatestInfraDriftCheck,
  type InfraDashboardPayload,
} from '@/lib/engine/infra/runtime/persistence';
import { listBudgets } from '@/lib/engine/governance/budgets';
import { ProvisioningPlanSchema } from '@/lib/engine/infra/planner/schema';
import { InfraSpecSchema } from '@/lib/engine/infra/spec';
import { requireProjectOwnership, requireUser } from '@/lib/auth';
import { deriveJourney } from '@/lib/journey';
import { getProjectSpend } from '@/lib/engine/governance/ledger';
import {
  loadConnectionPublic,
  type ConnectionPublic,
} from '@/lib/engine/integrations/connections';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { getServerSupabase } from '@/lib/supabase';
import { assembleForgeTimeline } from '@/lib/engine/observability/timeline';
import { ForgeTimelinePanel } from '@/components/observability/ForgeTimelinePanel';
import type {
  AgentRun,
  AgentRuntime,
  Build,
  BuildFile,
  BuildLogs,
  Deployment,
  Plan,
  Project,
  SandboxLogLine,
  SandboxRun,
  Spec,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PageQuery {
  github_connected?: string;
  github_error?: string;
  vercel_connected?: string;
  vercel_error?: string;
}

interface PageProps {
  params: { id: string };
  searchParams?: PageQuery;
}

async function loadProject(id: string, userId: string): Promise<{
  project: Project;
  spec: Spec | null;
  plan: Plan | null;
  build: Build | null;
  files: BuildFile[];
  sandboxRun: SandboxRun | null;
  githubConnection: ConnectionPublic | null;
  vercelConnection: ConnectionPublic | null;
  latestDeployment: Deployment | null;
  runtime: AgentRuntime | null;
  recentRuns: AgentRun[];
  // Phase 3-5a: the software DB record + the user's Supabase
  // Management connection. Both are software-only (no relevance for
  // agent / system / infrastructure builds). The DB row is sanitised
  // before reaching the client — the encrypted service-role blob
  // never leaves the server.
  softwareDb: PublicSoftwareDatabase | null;
  supabaseConnection: ConnectionPublic | null;
  // Phase 3-6: assembled dashboard payload — only populated for
  // software builds that have reached deployed/running. The shape
  // intentionally has no service-role-key field.
  softwareDashboard: SoftwareDashboardPayload | null;
  // Phase 4-4: the latest preview row for an infrastructure build.
  // Sanitised before reaching the client; the preview blob carries
  // no secrets (catalog-derived strings + cost numbers).
  infraPreview: PublicInfraPreview | null;
  // Phase 4-5a: the latest real-plan row. Sanitised at the cloud-
  // provider boundary (no secret-shaped strings); the plan_diff
  // blob is safe to send to the client.
  infraPlan: PublicInfraPlan | null;
  // Phase 4-5b: the latest apply row. The encrypted state is
  // STRIPPED at the boundary — only state_present (boolean),
  // sanitised outputs, counts, and the billed cost reach the client.
  infraApply: PublicInfraApply | null;
  // Phase 4-6: assembled monitoring dashboard payload — only set
  // for provisioned infra builds. The encrypted state is
  // INTENTIONALLY ABSENT from this shape by construction.
  infraDashboard: InfraDashboardPayload | null;
} | null> {
  const supabase = getServerSupabase();
  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !project) return null;

  const { data: specs } = await supabase
    .from('specs')
    .select('*')
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .limit(1);
  const spec = (specs?.[0] as Spec | undefined) ?? null;

  let plan: Plan | null = null;
  let build: Build | null = null;
  let files: BuildFile[] = [];

  if (spec && spec.status === 'confirmed') {
    const { data: plans } = await supabase
      .from('plans')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    plan = (plans?.[0] as Plan | undefined) ?? null;
  }

  let sandboxRun: SandboxRun | null = null;
  let githubConnection: ConnectionPublic | null = null;
  let vercelConnection: ConnectionPublic | null = null;
  let latestDeployment: Deployment | null = null;
  let runtime: AgentRuntime | null = null;
  let recentRuns: AgentRun[] = [];
  let softwareDb: PublicSoftwareDatabase | null = null;
  let supabaseConnection: ConnectionPublic | null = null;

  if (plan && plan.status === 'approved') {
    const { data: builds } = await supabase
      .from('builds')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    build = (builds?.[0] as Build | undefined) ?? null;
    if (build) {
      const { data: bf } = await supabase
        .from('build_files')
        .select('*')
        .eq('build_id', build.id)
        .order('path', { ascending: true });
      files = (bf ?? []) as BuildFile[];

      if (
        build.status === 'testing' ||
        build.status === 'tested' ||
        build.status === 'test_failed' ||
        build.status === 'pushing' ||
        build.status === 'pushed' ||
        build.status === 'push_failed'
      ) {
        const { data: runs } = await supabase
          .from('sandbox_runs')
          .select('*')
          .eq('build_id', build.id)
          .order('created_at', { ascending: false })
          .limit(1);
        sandboxRun = (runs?.[0] as SandboxRun | undefined) ?? null;
      }

      // Look up the GitHub connection once we're at or past tested. We
      // intentionally use the public (token-free) loader on this page.
      if (
        build.status === 'tested' ||
        build.status === 'pushing' ||
        build.status === 'pushed' ||
        build.status === 'push_failed' ||
        build.status === 'deploying' ||
        build.status === 'deployed' ||
        build.status === 'deploy_failed'
      ) {
        try {
          githubConnection = await loadConnectionPublic(supabase, 'github', userId);
        } catch {
          githubConnection = null;
        }
      }

      // Vercel connection + latest deployment record from 'pushed' onwards.
      if (
        build.status === 'pushed' ||
        build.status === 'deploying' ||
        build.status === 'deployed' ||
        build.status === 'deploy_failed' ||
        build.status === 'running'
      ) {
        try {
          vercelConnection = await loadConnectionPublic(supabase, 'vercel', userId);
        } catch {
          vercelConnection = null;
        }
        const { data: deps } = await supabase
          .from('deployments')
          .select('*')
          .eq('build_id', build.id)
          .order('created_at', { ascending: false })
          .limit(1);
        latestDeployment = (deps?.[0] as Deployment | undefined) ?? null;
      }

      // Runtime: always look up when the build is at a status where a
      // runtime could exist. Phase 1 agents reach 'pushed' before
      // activation; Phase 2 systems reach 'deployed' before activation;
      // both flip to 'running' once activated. Even a 'stopped' runtime
      // row is useful for showing run history.
      if (
        build.status === 'pushed' ||
        build.status === 'deployed' ||
        build.status === 'running'
      ) {
        const { data: rt } = await supabase
          .from('agent_runtimes')
          .select('*')
          .eq('project_id', id)
          .order('created_at', { ascending: false })
          .limit(1);
        runtime = (rt?.[0] as AgentRuntime | undefined) ?? null;
        if (runtime) {
          const { data: runs } = await supabase
            .from('runs')
            .select('*')
            .eq('runtime_id', runtime.id)
            .order('created_at', { ascending: false })
            .limit(10);
          recentRuns = (runs ?? []) as AgentRun[];
        }
      }
    }
  }

  // Phase 3-5a/b (Software) DB + connection state. Load once the
  // build has reached at least 'tested'; keep it loaded through push
  // + deploy so the deployed panel can surface the wired env recap.
  let softwareDashboard: SoftwareDashboardPayload | null = null;
  let infraPreview: PublicInfraPreview | null = null;
  let infraPlan: PublicInfraPlan | null = null;
  let infraApply: PublicInfraApply | null = null;
  let infraDashboard: InfraDashboardPayload | null = null;
  if (
    build &&
    build.kind === 'software' &&
    (build.status === 'tested' ||
      build.status === 'provisioning' ||
      build.status === 'provisioned' ||
      build.status === 'provision_failed' ||
      build.status === 'pushing' ||
      build.status === 'pushed' ||
      build.status === 'push_failed' ||
      build.status === 'deploying' ||
      build.status === 'deployed' ||
      build.status === 'deploy_failed' ||
      build.status === 'running')
  ) {
    try {
      const row = await loadLatestSoftwareDatabase(supabase, build.id);
      softwareDb = row ? sanitizeDbForResponse(row) : null;
    } catch {
      softwareDb = null;
    }
    try {
      supabaseConnection = await loadConnectionPublic(
        supabase,
        'supabase',
        userId,
      );
    } catch {
      supabaseConnection = null;
    }

    // Phase 3-6: pull the software runtime row, auto-pause it on the
    // way out if a kill switch is active in the applicable scope, and
    // assemble the dashboard payload. The runtime row IS the software
    // "live" marker; the kill switch sync is the gate that takes the
    // app offline without any background process needing to fire.
    if (
      build.status === 'deployed' ||
      build.status === 'deploy_failed' ||
      build.status === 'running'
    ) {
      let softwareRuntime = await loadSoftwareRuntimeForProject(
        supabase,
        build.project_id,
      );
      const kill = await activeKillSwitch(
        { userId, projectId: build.project_id },
        supabase,
      );
      if (softwareRuntime) {
        softwareRuntime = await syncSoftwareRuntimeWithKillSwitch(
          supabase,
          softwareRuntime,
          { userId, projectId: build.project_id },
        );
      }
      // Reload the latest DB row (with full encrypted blob) for the
      // dashboard assembly — but DO NOT pass it to the client. The
      // assembler strips the encrypted + plaintext fields by
      // constructing only the sanitised dashboard shape.
      const rawDb = await loadLatestSoftwareDatabase(supabase, build.id);
      // Re-parse the SoftwareSpec for the dashboard summary.
      const parsedSpec = spec ? SoftwareSpecSchema.safeParse(spec.structured_spec) : null;
      if (parsedSpec && parsedSpec.success) {
        softwareDashboard = assembleSoftwareDashboard({
          project,
          build,
          spec: parsedSpec.data,
          runtime: softwareRuntime,
          db: rawDb,
          deployment: latestDeployment,
          githubAccountLogin: githubConnection?.account_login ?? null,
          vercelAccountLogin: vercelConnection?.account_login ?? null,
          killSwitch: kill
            ? {
                active: true,
                scope: kill.scope as 'global' | 'user' | 'project',
                reason: kill.reason,
              }
            : { active: false, scope: null, reason: null },
        });
      }
      // Expose the software runtime so deriveJourney can read it.
      // Reuse the existing `runtime` variable — the journey function
      // reads runtime.kind to dispatch.
      if (softwareRuntime) runtime = softwareRuntime;
    }
  }

  // Phase 4-4 (Infrastructure) preview. Load the latest infra_previews
  // row whenever an infra build has reached at least 'generated' so
  // the UI can surface the verdict + cost-breakdown on every page
  // load. The preview blob is INERT (catalog-derived strings + cost
  // numbers) — safe to send to the client as-is.
  if (
    build &&
    build.kind === 'infrastructure' &&
    (build.status === 'generated' ||
      build.status === 'previewing' ||
      build.status === 'previewed' ||
      build.status === 'preview_blocked' ||
      build.status === 'planning' ||
      build.status === 'plan_blocked' ||
      build.status === 'plan_confirmed')
  ) {
    try {
      const row = await loadLatestInfraPreview(supabase, build.id);
      infraPreview = row ? sanitizeInfraPreviewForResponse(row) : null;
    } catch {
      infraPreview = null;
    }
  }

  // Phase 4-5a (Infrastructure) real-plan row. Load whenever the
  // build has reached at least 'previewed' so the UI can render the
  // live diff + confirm gate on every page load. The plan_diff is
  // sanitised at the CloudProvider boundary; safe to send as-is.
  if (
    build &&
    build.kind === 'infrastructure' &&
    (build.status === 'previewed' ||
      build.status === 'planning' ||
      build.status === 'plan_blocked' ||
      build.status === 'plan_confirmed' ||
      build.status === 'applying' ||
      build.status === 'provisioned' ||
      build.status === 'apply_failed' ||
      build.status === 'destroying' ||
      build.status === 'destroyed')
  ) {
    try {
      const row = await loadLatestInfraPlanRow(supabase, build.id);
      infraPlan = row ? sanitizeInfraPlanForResponse(row) : null;
    } catch {
      infraPlan = null;
    }
  }

  // Phase 4-5b (Infrastructure) apply row. Load whenever the build
  // has reached at least 'applying' so the UI can render the
  // provisioned panel (or the apply-failed view) on every page
  // load. The sanitiser strips the encrypted state from the
  // client-bound payload; only the state_present boolean travels.
  if (
    build &&
    build.kind === 'infrastructure' &&
    (build.status === 'applying' ||
      build.status === 'provisioned' ||
      build.status === 'apply_failed' ||
      build.status === 'destroying' ||
      build.status === 'destroyed')
  ) {
    try {
      const row = await loadLatestInfraApply(supabase, build.id);
      infraApply = row ? sanitizeInfraApplyForResponse(row) : null;
    } catch {
      infraApply = null;
    }
  }

  // Phase 4-6 (Infrastructure) MONITOR dashboard. Only assemble for
  // 'provisioned' (or 'destroying' so the dashboard still renders
  // while teardown is in flight). The dashboard intentionally has
  // NO encrypted-state field by construction; the assembler reads
  // ONLY the sanitised apply row + drift check + ledger spend +
  // kill-switch snapshot.
  if (
    build &&
    build.kind === 'infrastructure' &&
    (build.status === 'provisioned' || build.status === 'destroying') &&
    spec &&
    plan
  ) {
    try {
      const rawApply = await loadLatestInfraApply(supabase, build.id);
      const parsedSpec = InfraSpecSchema.safeParse(spec.structured_spec);
      // Latest drift check + accrued spend + kill switch in parallel.
      if (rawApply && parsedSpec.success) {
        const [driftRow, spend, kill, budgets, latestPlan] = await Promise.all([
          loadLatestInfraDriftCheck(supabase, rawApply.id),
          getProjectSpend(build.project_id).catch(() => 0),
          activeKillSwitch(
            { userId, projectId: build.project_id },
            supabase,
          ),
          listBudgets(userId, supabase).catch(() => []),
          loadLatestInfraPlanRow(supabase, build.id).catch(() => null),
        ]);
        const hardCap = budgets.find((b) => b.hard_cap);
        infraDashboard = assembleInfraDashboard({
          project,
          build,
          spec: parsedSpec.data,
          apply: rawApply,
          drift: driftRow,
          accruedUsdTotal: spend,
          ceilingPeriod: hardCap
            ? (hardCap.period as 'monthly' | 'daily')
            : null,
          ceilingLimitUsd: hardCap ? Number(hardCap.limit_usd) : null,
          killSwitch: kill
            ? {
                active: true,
                scope: kill.scope as 'global' | 'user' | 'project',
                reason: kill.reason,
              }
            : { active: false, scope: null, reason: null },
          typedPhraseRequired: latestPlan?.typed_phrase_required ?? null,
        });
      }
    } catch {
      infraDashboard = null;
    }
  }

  return {
    project,
    spec,
    plan,
    build,
    files,
    sandboxRun,
    githubConnection,
    vercelConnection,
    latestDeployment,
    runtime,
    recentRuns,
    softwareDb,
    supabaseConnection,
    softwareDashboard,
    infraPreview,
    infraPlan,
    infraApply,
    infraDashboard,
  };
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: PageProps) {
  const user = await requireUser();
  const ownership = await requireProjectOwnership(params.id, user);
  if ('error' in ownership) {
    // 404 covers both "missing" and "not yours" so we don't leak existence.
    notFound();
  }
  const data = await loadProject(params.id, user.id);
  if (!data) notFound();
  const {
    project,
    spec,
    plan,
    build,
    files,
    sandboxRun,
    githubConnection,
    vercelConnection,
    latestDeployment,
    runtime,
    recentRuns,
    softwareDb,
    supabaseConnection,
    softwareDashboard,
    infraPreview,
    infraPlan,
    infraApply,
    infraDashboard,
  } = data;
  const githubError = searchParams?.github_error ?? null;
  const vercelError = searchParams?.vercel_error ?? null;
  const vercelOauthAvailable = Boolean(
    process.env.VERCEL_OAUTH_CLIENT_ID &&
      process.env.VERCEL_INTEGRATION_SLUG,
  );

  const parsedPlan = plan?.plan
    ? BuildPlanSchema.safeParse(plan.plan)
    : null;
  const parsedSpec = spec?.structured_spec
    ? AgentSpecSchema.safeParse(spec.structured_spec)
    : null;
  const validBuildPlan: BuildPlan | null =
    parsedPlan && parsedPlan.success ? parsedPlan.data : null;
  const validAgentSpec: AgentSpec | null =
    parsedSpec && parsedSpec.success ? parsedSpec.data : null;

  const journey = deriveJourney({ project, spec, plan, build, runtime });
  const costToDateUsd = await getProjectSpend(project.id).catch(() => 0);
  const shipped = journey.isLive;

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 py-12">
      <header>
        <Link
          href="/projects"
          className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim hover:text-forge-text"
        >
          ← archive
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              project · {project.id.slice(0, 8)}
            </p>
            <h1 className="mt-2 text-3xl font-medium text-forge-text">
              {project.name}
            </h1>
          </div>
          <span className="rounded-full border border-forge-amber/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
            {project.status}
          </span>
        </div>
      </header>

      {/* Mirror the page's journey into the persistent 3D world. */}
      <JourneyBridge journey={journey} />

      {/* The labelled strip — readable regardless of WebGL availability. */}
      <JourneyOverlay journey={journey} />

      {/* Shipped agents get the dashboard up top, before all the workshop panels. */}
      {shipped && validAgentSpec && build ? (
        <AgentDashboard
          project={project}
          spec={validAgentSpec}
          build={build}
          runtime={runtime}
          runs={recentRuns}
          costToDateUsd={costToDateUsd}
          isRuntimeMode={journey.isRuntimeMode}
        />
      ) : null}

      <GlassPanel>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
          raw intent
        </h2>
        <p className="mt-3 whitespace-pre-wrap font-mono text-sm leading-relaxed text-forge-text">
          {spec?.raw_prompt ?? '—'}
        </p>
      </GlassPanel>

      <SpecArea projectId={project.id} spec={spec} />

      {/*
        Phase 2/3/4 gates: the AGENT planner / build / push / deploy /
        runtime panels are AgentSpec-only. SystemSpec gets its own
        orchestration-plan area below; SoftwareSpec gets its own
        build-plan area; InfraSpec (Phase 4) gets its own provisioning-
        plan area and STOPS after approval — generation, preview, and
        provisioning stay closed for kind='infrastructure'. The three
        sibling planner persistences refuse a confirmed infrastructure
        spec with 409 as defence in depth.
      */}
      {spec?.status === 'confirmed' && spec.kind === 'system' ? (
        <SystemPlanArea projectId={project.id} plan={plan} />
      ) : null}

      {spec?.status === 'confirmed' && spec.kind === 'software' ? (
        <SoftwarePlanArea projectId={project.id} plan={plan} />
      ) : null}

      {spec?.status === 'confirmed' && spec.kind === 'infrastructure' ? (
        <InfraPlanArea projectId={project.id} plan={plan} />
      ) : null}

      {spec?.status === 'confirmed' && spec.kind === 'agent' ? (
        <PlanArea projectId={project.id} plan={plan} />
      ) : null}

      {plan?.status === 'approved' && spec?.kind === 'agent' ? (
        <BuildArea projectId={project.id} build={build} files={files} />
      ) : null}

      {/* Phase 2 (Systems) codegen area — fires for an approved
          orchestration plan on a system project. System stops here:
          sandbox test / deploy / runtime stay closed for kind='system',
          enforced both by the absence of system-specific routes for
          those layers AND by the spec.kind==='agent' guards added
          below. */}
      {plan?.status === 'approved' && spec?.kind === 'system' ? (
        <SystemBuildArea
          projectId={project.id}
          projectName={project.name}
          spec={spec}
          plan={plan}
          build={build}
          files={files}
          sandboxRun={sandboxRun}
          githubConnection={githubConnection}
          githubError={githubError}
          vercelConnection={vercelConnection}
          vercelError={vercelError}
          vercelOauthAvailable={vercelOauthAvailable}
          runtime={runtime}
          recentRuns={recentRuns}
          costToDateUsd={costToDateUsd}
        />
      ) : null}

      {/* Phase 3 (Software) codegen area — fires for an approved
          software build plan. Software stops here in this phase: app
          sandbox test / DB provisioning + deploy / runtime stay
          closed for kind='software'. The agent + system codegen
          loaders both 409 a software project as defence in depth. */}
      {plan?.status === 'approved' && spec?.kind === 'software' ? (
        <SoftwareBuildArea
          projectId={project.id}
          projectName={project.name}
          spec={spec}
          build={build}
          files={files}
          sandboxRun={sandboxRun}
          softwareDb={softwareDb}
          supabaseConnection={supabaseConnection}
          githubConnection={githubConnection}
          githubError={githubError}
          vercelConnection={vercelConnection}
          vercelError={vercelError}
          vercelOauthAvailable={vercelOauthAvailable}
          latestDeployment={latestDeployment}
          softwareDashboard={softwareDashboard}
        />
      ) : null}

      {/* Phase 4 (Infrastructure) IaC codegen area — fires for an
          approved provisioning plan on an infra project. Infra STOPS
          here in P4-3: preview, provision/apply, and runtime stay
          closed for kind='infrastructure'. The agent / system /
          software codegen loaders all 409 an infra project as
          defence in depth. */}
      {plan?.status === 'approved' && spec?.kind === 'infrastructure' ? (
        <InfraBuildArea
          projectId={project.id}
          spec={spec}
          plan={plan}
          build={build}
          files={files}
          infraPreview={infraPreview}
          infraPlan={infraPlan}
          infraApply={infraApply}
          infraDashboard={infraDashboard}
        />
      ) : null}

      {build &&
      spec?.kind === 'agent' &&
      (build.status === 'generated' ||
        build.status === 'testing' ||
        build.status === 'tested' ||
        build.status === 'test_failed' ||
        build.status === 'pushing' ||
        build.status === 'pushed' ||
        build.status === 'push_failed') ? (
        <TestArea
          projectId={project.id}
          build={build}
          sandboxRun={sandboxRun}
        />
      ) : null}

      {build &&
      spec?.kind === 'agent' &&
      (build.status === 'tested' ||
        build.status === 'pushing' ||
        build.status === 'pushed' ||
        build.status === 'push_failed' ||
        build.status === 'deploying' ||
        build.status === 'deployed' ||
        build.status === 'deploy_failed') ? (
        <PushArea
          projectId={project.id}
          projectName={project.name}
          build={build}
          filesCount={files.length}
          githubConnection={githubConnection}
          githubError={githubError}
        />
      ) : null}

      {build &&
      validBuildPlan &&
      validAgentSpec &&
      (build.status === 'pushed' ||
        build.status === 'deploying' ||
        build.status === 'deployed' ||
        build.status === 'deploy_failed') ? (
        <DeployArea
          projectId={project.id}
          projectName={project.name}
          build={build}
          filesCount={files.length}
          plan={validBuildPlan}
          spec={validAgentSpec}
          githubRepoUrl={build.repo_url}
          vercelConnection={vercelConnection}
          latestDeployment={latestDeployment}
          vercelOauthAvailable={vercelOauthAvailable}
          vercelError={vercelError}
        />
      ) : null}

      {build &&
      validBuildPlan &&
      validAgentSpec &&
      isRuntimeMode(validBuildPlan, validAgentSpec) &&
      (build.status === 'pushed' || build.status === 'running') ? (
        <RuntimeArea
          projectId={project.id}
          projectName={project.name}
          spec={validAgentSpec}
          plan={validBuildPlan}
          runtime={runtime}
          runs={recentRuns}
        />
      ) : null}

      <GlassPanel className="border-dashed">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          cross-project dashboard · reserved
        </h2>
        <p className="mt-3 text-sm text-forge-dim">
          Future: cross-project runtime telemetry, alerts, and cost
          governance. The per-project runtime view above is live now.
        </p>
      </GlassPanel>

      {/* FORGE TIMELINE — observability data layer. Always-visible,
          collapsed by default. The disclosure header carries the total
          cost as a teaser. Live-tail polls every 5s when expanded AND
          the latest build is in-progress; idle otherwise. */}
      {await renderForgeTimeline(project.id)}
    </section>
  );
}

async function renderForgeTimeline(
  projectId: string,
): Promise<React.ReactNode> {
  const supabase = getServerSupabase();
  const [timeline, latest] = await Promise.all([
    assembleForgeTimeline(supabase, projectId),
    supabase
      .from('builds')
      .select('status')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => (data?.[0] as { status?: string } | undefined) ?? null),
  ]);
  return (
    <ForgeTimelinePanel
      timeline={timeline}
      buildStatus={latest?.status ?? null}
    />
  );
}

function isRuntimeMode(plan: BuildPlan, spec: AgentSpec): boolean {
  return plan.runtime_impl === 'always_on' || spec.trigger === 'schedule';
}

function SpecArea({
  projectId,
  spec,
}: {
  projectId: string;
  spec: Spec | null;
}) {
  if (!spec) {
    return (
      <GlassPanel className="border-dashed">
        <p className="text-sm text-forge-dim">
          No spec row exists for this project. (Re-create the project from the
          intake page.)
        </p>
      </GlassPanel>
    );
  }

  switch (spec.status) {
    case 'pending':
    case 'failed':
      return (
        <GenerateSpecPanel
          projectId={projectId}
          failedMessage={
            spec.status === 'failed'
              ? 'The previous extraction failed. You can retry.'
              : null
          }
        />
      );

    case 'extracting':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              extracting…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            The Forge is parsing your intent. This usually takes a few
            seconds. Refresh if it stalls.
          </p>
        </GlassPanel>
      );

    case 'needs_clarification': {
      const questions = Array.isArray(spec.open_questions)
        ? (spec.open_questions as unknown as string[])
        : [];
      if (questions.length === 0) {
        return <GenerateSpecPanel projectId={projectId} />;
      }
      return <ClarificationPanel projectId={projectId} questions={questions} />;
    }

    case 'awaiting_review': {
      // Phase 2/3/4: branch on the spec's `kind` discriminator. Each
      // kind has its own review panel + schema; agents continue to
      // render the unchanged AgentSpec review.
      if (spec.kind === 'infrastructure') {
        const parsedInfra = InfraSpecSchema.safeParse(spec.structured_spec);
        if (!parsedInfra.success) {
          return (
            <GenerateSpecPanel
              projectId={projectId}
              failedMessage="Saved infrastructure spec failed validation. Re-run extraction."
            />
          );
        }
        return (
          <InfraReviewPanel
            projectId={projectId}
            spec={parsedInfra.data}
            confidence={
              (spec.confidence_json as Record<string, never> | null) ?? null
            }
          />
        );
      }
      if (spec.kind === 'software') {
        const parsedSw = SoftwareSpecSchema.safeParse(spec.structured_spec);
        if (!parsedSw.success) {
          return (
            <GenerateSpecPanel
              projectId={projectId}
              failedMessage="Saved software spec failed validation. Re-run extraction."
            />
          );
        }
        return (
          <SoftwareReviewPanel
            projectId={projectId}
            spec={parsedSw.data}
            confidence={
              (spec.confidence_json as Record<string, never> | null) ?? null
            }
          />
        );
      }
      if (spec.kind === 'system') {
        const parsedSys = SystemSpecSchema.safeParse(spec.structured_spec);
        if (!parsedSys.success) {
          return (
            <GenerateSpecPanel
              projectId={projectId}
              failedMessage="Saved system spec failed validation. Re-run extraction."
            />
          );
        }
        return (
          <SystemReviewPanel
            projectId={projectId}
            spec={parsedSys.data}
            confidence={
              (spec.confidence_json as Record<string, never> | null) ?? null
            }
          />
        );
      }
      const parsed = AgentSpecSchema.safeParse(spec.structured_spec);
      if (!parsed.success) {
        return (
          <GenerateSpecPanel
            projectId={projectId}
            failedMessage="Saved spec failed validation. Re-run extraction."
          />
        );
      }
      return (
        <ReviewPanel
          projectId={projectId}
          spec={parsed.data}
          confidence={
            (spec.confidence_json as Record<string, never> | null) ?? null
          }
        />
      );
    }

    case 'confirmed': {
      if (spec.kind === 'infrastructure') {
        const parsedInfra = InfraSpecSchema.safeParse(spec.structured_spec);
        if (!parsedInfra.success) {
          return (
            <GlassPanel className="border-dashed">
              <p className="text-sm text-rose-300">
                Confirmed infrastructure spec failed validation against the current schema.
              </p>
            </GlassPanel>
          );
        }
        return <InfraConfirmedPanel spec={parsedInfra.data} />;
      }
      if (spec.kind === 'software') {
        const parsedSw = SoftwareSpecSchema.safeParse(spec.structured_spec);
        if (!parsedSw.success) {
          return (
            <GlassPanel className="border-dashed">
              <p className="text-sm text-rose-300">
                Confirmed software spec failed validation against the current schema.
              </p>
            </GlassPanel>
          );
        }
        return <SoftwareConfirmedPanel spec={parsedSw.data} />;
      }
      if (spec.kind === 'system') {
        const parsedSys = SystemSpecSchema.safeParse(spec.structured_spec);
        if (!parsedSys.success) {
          return (
            <GlassPanel className="border-dashed">
              <p className="text-sm text-rose-300">
                Confirmed system spec failed validation against the current schema.
              </p>
            </GlassPanel>
          );
        }
        return <SystemConfirmedPanel spec={parsedSys.data} />;
      }
      const parsed = AgentSpecSchema.safeParse(spec.structured_spec);
      if (!parsed.success) {
        return (
          <GlassPanel className="border-dashed">
            <p className="text-sm text-rose-300">
              Confirmed spec failed validation against the current schema.
            </p>
          </GlassPanel>
        );
      }
      return <ConfirmedPanel spec={parsed.data} />;
    }

    default:
      return <GenerateSpecPanel projectId={projectId} />;
  }
}

// Phase 2: orchestration-plan area for kind='system' projects. Mirrors
// PlanArea below but routes to the /system/plan/* endpoints and renders
// the OrchestrationPlanView. The page-level gate above only invokes
// this when spec.kind === 'system' AND spec.status === 'confirmed'.
function SystemPlanArea({
  projectId,
  plan,
}: {
  projectId: string;
  plan: Plan | null;
}) {
  // The page's plan-load reads the latest plan regardless of kind. For a
  // system project the latest plan should always be kind='system' (the
  // agent planner refuses to write here), but guard defensively.
  const isSystemPlan = !plan || plan.kind === 'system';

  if (!plan || plan.status === 'pending' || !isSystemPlan) {
    return <GenerateOrchestrationPanel projectId={projectId} />;
  }

  switch (plan.status) {
    case 'planning':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-cyan shadow-cyan" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              orchestrating…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Deriving the agent graph, validating handoffs, and grounding
            tool suggestions. Refresh if it stalls.
          </p>
        </GlassPanel>
      );

    case 'failed':
      return (
        <GenerateOrchestrationPanel
          projectId={projectId}
          failedMessage="The previous orchestration attempt failed. You can retry."
        />
      );

    case 'awaiting_review': {
      const parsed = OrchestrationPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GenerateOrchestrationPanel
            projectId={projectId}
            failedMessage="Saved orchestration plan failed validation. Re-run planning."
          />
        );
      }
      // Render the graph alongside the list — the visual structure
      // helps reviewers see handoff topology before approval.
      return (
        <>
          <SystemGraphView plan={parsed.data} />
          <ReviewOrchestrationPanel projectId={projectId} plan={parsed.data} />
        </>
      );
    }

    case 'approved': {
      const parsed = OrchestrationPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GlassPanel className="border-dashed">
            <p className="text-sm text-rose-300">
              Approved orchestration plan failed validation against the current schema.
            </p>
          </GlassPanel>
        );
      }
      return (
        <>
          <SystemGraphView plan={parsed.data} />
          <ApprovedOrchestrationPanel plan={parsed.data} />
        </>
      );
    }

    default:
      return <GenerateOrchestrationPanel projectId={projectId} />;
  }
}

// Phase 2 (Systems) codegen + sandbox + deploy area. Mirrors the
// Phase 1 BuildArea + TestArea + PushArea + DeployArea but stays
// scoped to kind='system'. Routes to /system/build/{generate,test,
// push,deploy} and renders the read-only SystemBuildView + SystemTest
// View. The system pipeline STOPS at 'deployed': runtime activation
// for kind='system' lands in P2-5b. The agent-side downstream panels
// are gated on spec.kind === 'agent' so a system build never invites
// them.
function SystemBuildArea({
  projectId,
  projectName,
  spec,
  plan,
  build,
  files,
  sandboxRun,
  githubConnection,
  githubError,
  vercelConnection,
  vercelError,
  vercelOauthAvailable,
  runtime,
  recentRuns,
  costToDateUsd,
}: {
  projectId: string;
  projectName: string;
  spec: Spec;
  plan: Plan;
  build: Build | null;
  files: BuildFile[];
  sandboxRun: SandboxRun | null;
  githubConnection: ConnectionPublic | null;
  githubError: string | null;
  vercelConnection: ConnectionPublic | null;
  vercelError: string | null;
  vercelOauthAvailable: boolean;
  runtime: AgentRuntime | null;
  recentRuns: AgentRun[];
  costToDateUsd: number;
}) {
  // Parse the SystemSpec once so the activation flow can pre-fill its
  // mode default from spec.triggers. Falls back to false when the
  // schema has drifted; the server gate would refuse activation in
  // that case anyway.
  const parsedSysSpec = SystemSpecSchema.safeParse(spec.structured_spec);
  const hasScheduleTrigger = parsedSysSpec.success
    ? parsedSysSpec.data.triggers.includes('schedule')
    : false;
  // Best-effort node count for the kickoff panel copy. Falls back to 0
  // if the plan blob has drifted from the schema (the planner gate
  // would have refused approval, but defensive lookup is cheap).
  const parsedPlan = OrchestrationPlanSchema.safeParse(plan.plan);
  const nodeCount = parsedPlan.success ? parsedPlan.data.nodes.length : 0;

  // No build yet, or build belongs to a different plan, or build is
  // queued/awaiting kick-off → render the generate panel.
  if (
    !build ||
    build.kind !== 'system' ||
    build.status === 'queued' ||
    build.status === 'pending'
  ) {
    return <GenerateSystemBuildPanel projectId={projectId} nodeCount={nodeCount} />;
  }

  if (build.status === 'generating') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            forging system code…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          Materialising the scaffold + deterministic orchestrator, then
          generating one module per sub-agent. Each file is statically
          parsed; nothing is executed at this layer.
        </p>
      </GlassPanel>
    );
  }

  if (build.status === 'failed') {
    return (
      <GenerateSystemBuildPanel
        projectId={projectId}
        nodeCount={nodeCount}
        failedMessage="The previous system codegen attempt failed. You can retry."
      />
    );
  }

  // Build is generated or further along. Read static-check logs from
  // build.logs (codegen leaves them there); read sandbox phases from
  // sandboxRun.logs (sandbox harness leaves them there).
  const logs = (build.logs as BuildLogs | null) ?? {};
  const staticChecks =
    (logs.static_checks ?? []).map((c) => ({
      path: c.path,
      status: (c.status as StaticStatus) ?? 'skipped',
      error: c.error,
    })) ?? [];
  const warnings = logs.warnings ?? [];
  const failedCount = staticChecks.filter((c) => c.status === 'failed').length;

  const orchestratorPath =
    files.find((f) => f.path === 'src/orchestrator.ts')?.path ?? null;
  const entrypointPath = files.find((f) => f.path === 'src/index.ts')?.path ?? null;
  const moduleCount = files.filter((f) =>
    f.path.startsWith('src/modules/'),
  ).length;

  const buildView = (
    <SystemBuildView
      files={files}
      staticChecks={staticChecks}
      warnings={warnings}
      failedCount={failedCount}
      orchestratorPath={orchestratorPath}
      entrypointPath={entrypointPath}
      moduleCount={moduleCount}
      repoUrl={build.repo_url ?? null}
      deployUrl={build.deploy_url ?? null}
    />
  );

  // build.status === 'generated' → ready to sandbox-test, kickoff panel.
  if (build.status === 'generated') {
    return (
      <>
        {buildView}
        <TestSystemBuildPanel projectId={projectId} nodeCount={nodeCount} />
      </>
    );
  }

  // build.status === 'testing' → in-flight progress strip.
  if (build.status === 'testing') {
    return (
      <>
        {buildView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              system sandbox · running…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Provisioning a disposable sandbox, installing dependencies,
            real-compiling the orchestrator + modules, and walking the
            full execution order with tools in mock mode. The chamber is
            destroyed when the run ends — refresh in ~1–2 minutes.
          </p>
        </GlassPanel>
      </>
    );
  }

  // Past 'testing', render the test view from the sandbox_run row
  // (status 'tested' / 'test_failed' or any downstream state).
  const sandboxLogs = readSystemSandboxLogs(sandboxRun);
  const testView = sandboxRun ? (
    <SystemTestView
      passed={
        build.status === 'tested' ||
        build.status === 'pushing' ||
        build.status === 'pushed' ||
        build.status === 'push_failed' ||
        build.status === 'deploying' ||
        build.status === 'deployed' ||
        build.status === 'deploy_failed'
      }
      buildOk={sandboxRun.build_ok ?? null}
      smokeOk={sandboxRun.smoke_ok ?? null}
      durationMs={sandboxRun.duration_ms ?? null}
      provider={sandboxRun.provider ?? 'unknown'}
      iterations={sandboxRun.iterations ?? 0}
      phases={sandboxLogs.phases}
      lines={sandboxLogs.lines}
      selfHealAttempts={sandboxLogs.selfHealAttempts}
      error={sandboxRun.error ?? null}
    />
  ) : null;

  // build.status === 'test_failed' — render the failed test view +
  // a retry kickoff. No push gate fires from a failed test.
  if (build.status === 'test_failed') {
    return (
      <>
        {buildView}
        {testView}
        <TestSystemBuildPanel
          projectId={projectId}
          nodeCount={nodeCount}
          isRetry
          failedMessage="The previous sandbox run failed (self-heal already exhausted, if applicable). You can retry as a fresh run."
        />
      </>
    );
  }

  // build.status === 'tested' — sandbox passed; render the push gate.
  // Authorization Gate #1: explicit "create the private repo and push?"
  if (build.status === 'tested') {
    return (
      <>
        {buildView}
        {testView}
        {githubConnection && githubConnection.account_login ? (
          <SystemGitHubPushPanel
            projectId={projectId}
            projectName={projectName}
            accountLogin={githubConnection.account_login}
            filesCount={files.length}
            moduleCount={moduleCount}
          />
        ) : (
          <ConnectGitHubPanel
            projectId={projectId}
            errorFlash={
              githubError ??
              (githubConnection && !githubConnection.account_login
                ? 'connection missing account_login; reconnect'
                : null)
            }
          />
        )}
      </>
    );
  }

  // build.status === 'pushing' → push in flight.
  if (build.status === 'pushing') {
    return (
      <>
        {buildView}
        {testView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              pushing system to github…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Creating the private repo and committing every file. Refresh in
            a few seconds.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'push_failed' → retry the push gate.
  if (build.status === 'push_failed') {
    return (
      <>
        {buildView}
        {testView}
        {githubConnection && githubConnection.account_login ? (
          <SystemGitHubPushPanel
            projectId={projectId}
            projectName={projectName}
            accountLogin={githubConnection.account_login}
            filesCount={files.length}
            moduleCount={moduleCount}
          />
        ) : (
          <ConnectGitHubPanel
            projectId={projectId}
            errorFlash={githubError ?? null}
          />
        )}
      </>
    );
  }

  // From here on the build is past push: 'pushed' / 'deploying' /
  // 'deployed' / 'deploy_failed'. Authorization Gate #2 mounts when
  // pushed; runtime activation for kind='system' is NOT wired in this
  // phase.

  // Parse the OrchestrationPlan one more time so we can aggregate
  // env_required for the deploy form. Falls back to an empty list
  // when the schema has drifted; the deploy route re-derives this
  // server-side so a UI miss doesn't compromise the secret slots.
  const envRequired = parsedPlan.success
    ? aggregateSystemEnvRequired(parsedPlan.data)
    : [];

  if (build.status === 'deploying') {
    return (
      <>
        {buildView}
        {testView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              deploying system to vercel…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Uploading the orchestrator + modules → building on Vercel → going
            live. This usually takes 1–3 minutes. Refresh if it stalls.
          </p>
        </GlassPanel>
      </>
    );
  }

  // The orchestration graph: shown alongside the deploy / runtime
  // panels so the reviewer sees the multi-agent shape AT the moment
  // they're about to activate it. Latest run (if any) is overlaid as
  // a per-node pass/fail trail.
  const graphView = parsedPlan.success ? (
    <SystemGraphView plan={parsedPlan.data} run={recentRuns[0] ?? null} />
  ) : null;

  // build.status === 'deployed' → show the deploy banner + the
  // activation gate (when no runtime exists yet). If a runtime exists
  // and is anything but stopped, the build would normally be 'running',
  // but we defensively also render the panel here.
  if (build.status === 'deployed') {
    const hasActiveRuntime =
      runtime && runtime.status !== 'stopped' && runtime.kind === 'system';
    if (hasActiveRuntime && runtime) {
      return (
        <>
          {buildView}
          {testView}
          {graphView}
          <SystemRuntimePanel
            projectId={projectId}
            runtime={runtime}
            runs={recentRuns}
            nodeCount={moduleCount}
            costToDateUsd={costToDateUsd}
          />
        </>
      );
    }
    return (
      <>
        {buildView}
        {testView}
        {graphView}
        <GlassPanel className="border-forge-amber/30 shadow-amber">
          <div className="flex flex-col gap-3">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              system · deployed
            </h2>
            <p className="text-sm text-forge-dim">
              {projectName} is deployed at the URL above. Activate the
              runtime below to run the orchestration on a cron — one tick =
              one orchestration, governed by the shared cost ceiling.
            </p>
          </div>
        </GlassPanel>
        <SystemActivateRuntimeFlow
          projectId={projectId}
          projectName={projectName}
          envRequired={envRequired}
          hasScheduleTrigger={hasScheduleTrigger}
          nodeCount={moduleCount}
        />
      </>
    );
  }

  // build.status === 'running' → an active system runtime exists.
  // Render the SystemRuntimePanel. If the runtime row is somehow
  // missing or stopped, fall back to the activation flow.
  if (build.status === 'running') {
    if (runtime && runtime.kind === 'system' && runtime.status !== 'stopped') {
      return (
        <>
          {buildView}
          {testView}
          {graphView}
          <SystemRuntimePanel
            projectId={projectId}
            runtime={runtime}
            runs={recentRuns}
            nodeCount={moduleCount}
            costToDateUsd={costToDateUsd}
          />
        </>
      );
    }
    // Defensive — no runtime row but build is 'running'. Show
    // activation as the recovery path.
    return (
      <>
        {buildView}
        {testView}
        {graphView}
        <SystemActivateRuntimeFlow
          projectId={projectId}
          projectName={projectName}
          envRequired={envRequired}
          hasScheduleTrigger={false}
          nodeCount={moduleCount}
        />
      </>
    );
  }

  // build.status === 'pushed' or 'deploy_failed' → render the deploy
  // gate (with a flash on the failed branch).
  const deployFailedFlash =
    build.status === 'deploy_failed'
      ? 'The previous deploy failed. You can retry from here.'
      : null;
  if (!vercelConnection) {
    return (
      <>
        {buildView}
        {testView}
        <ConnectVercelPanel
          projectId={projectId}
          oauthAvailable={vercelOauthAvailable}
          errorFlash={vercelError ?? deployFailedFlash}
        />
      </>
    );
  }
  if (!vercelConnection.account_login) {
    return (
      <>
        {buildView}
        {testView}
        <ConnectVercelPanel
          projectId={projectId}
          oauthAvailable={vercelOauthAvailable}
          errorFlash="connection missing account_login; reconnect"
        />
      </>
    );
  }
  return (
    <>
      {buildView}
      {testView}
      {deployFailedFlash ? (
        <GlassPanel className="border-rose-400/30">
          <p className="text-sm text-rose-200">{deployFailedFlash}</p>
        </GlassPanel>
      ) : null}
      <SystemDeployFlow
        projectId={projectId}
        projectName={projectName}
        accountLogin={vercelConnection.account_login}
        filesCount={files.length}
        moduleCount={moduleCount}
        envRequired={envRequired}
      />
    </>
  );
}

// Read the system sandbox_run's stored payload. Tolerates rows
// written before self-heal landed (missing `selfheal_attempts` array).
function readSystemSandboxLogs(run: SandboxRun | null): {
  phases: Array<{
    phase: 'install' | 'build' | 'smoke';
    status: 'ok' | 'failed' | 'skipped';
    exit_code: number | null;
    timed_out: boolean;
    duration_ms: number;
    iteration: number;
  }>;
  lines: SandboxLogLine[];
  selfHealAttempts: Array<{
    node_id: string;
    module_regen_ok: boolean;
    smoke_ok_after_retry: boolean;
  }>;
} {
  if (!run) return { phases: [], lines: [], selfHealAttempts: [] };
  const payload = (run.logs as {
    phases?: Array<{
      phase: 'install' | 'build' | 'smoke';
      status: 'ok' | 'failed' | 'skipped';
      exit_code: number | null;
      timed_out: boolean;
      duration_ms: number;
      iteration?: number;
    }>;
    lines?: SandboxLogLine[];
    selfheal_attempts?: Array<{
      node_id: string;
      module_regen_ok: boolean;
      smoke_ok_after_retry: boolean;
    }>;
  } | null) ?? {};
  return {
    phases: (payload.phases ?? []).map((p) => ({
      phase: p.phase,
      status: p.status,
      exit_code: p.exit_code,
      timed_out: p.timed_out,
      duration_ms: p.duration_ms,
      // Older agent-shape rows don't carry iteration; default 0 so the
      // UI still renders.
      iteration: typeof p.iteration === 'number' ? p.iteration : 0,
    })),
    lines: payload.lines ?? [],
    selfHealAttempts: payload.selfheal_attempts ?? [],
  };
}

// Phase 3: software build-plan area. Mirrors SystemPlanArea — routes
// to the /software/plan/* endpoints and renders the
// SoftwareBuildPlanView. Only invoked when spec.kind === 'software'.
function SoftwarePlanArea({
  projectId,
  plan,
}: {
  projectId: string;
  plan: Plan | null;
}) {
  const isSoftwarePlan = !plan || plan.kind === 'software';

  if (!plan || plan.status === 'pending' || !isSoftwarePlan) {
    return <GenerateSoftwarePlanPanel projectId={projectId} />;
  }

  switch (plan.status) {
    case 'planning':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-cyan shadow-cyan" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              planning…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Deriving the schema / API / UI / auth task graph and grounding it
            against the template. Refresh if it stalls.
          </p>
        </GlassPanel>
      );

    case 'failed':
      return (
        <GenerateSoftwarePlanPanel
          projectId={projectId}
          failedMessage="The previous build-plan attempt failed. You can retry."
        />
      );

    case 'awaiting_review': {
      const parsed = SoftwareBuildPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GenerateSoftwarePlanPanel
            projectId={projectId}
            failedMessage="Saved software build plan failed validation. Re-run planning."
          />
        );
      }
      return (
        <ReviewSoftwarePlanPanel projectId={projectId} plan={parsed.data} />
      );
    }

    case 'approved': {
      const parsed = SoftwareBuildPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GlassPanel className="border-dashed">
            <p className="text-sm text-rose-300">
              Approved software build plan failed validation against the current schema.
            </p>
          </GlassPanel>
        );
      }
      return <ApprovedSoftwarePlanPanel plan={parsed.data} />;
    }

    default:
      return <GenerateSoftwarePlanPanel projectId={projectId} />;
  }
}

// Phase 4: infrastructure provisioning-plan area. Mirrors
// SoftwarePlanArea — routes to the /infra/plan/* endpoints and renders
// the ProvisioningPlanView. Only invoked when spec.kind ===
// 'infrastructure'. Infrastructure STOPS after approval — there's no
// downstream generation / preview / provisioning panel for this kind.
function InfraPlanArea({
  projectId,
  plan,
}: {
  projectId: string;
  plan: Plan | null;
}) {
  const isInfraPlan = !plan || plan.kind === 'infrastructure';

  if (!plan || plan.status === 'pending' || !isInfraPlan) {
    return <GenerateInfraPlanPanel projectId={projectId} />;
  }

  switch (plan.status) {
    case 'planning':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-cyan shadow-cyan" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              composing modules…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Deriving the network → data → compute → observability provisioning
            DAG and grounding it against the closed module catalog. Refresh if
            it stalls.
          </p>
        </GlassPanel>
      );

    case 'failed':
      return (
        <GenerateInfraPlanPanel
          projectId={projectId}
          failedMessage="The previous provisioning-plan attempt failed. You can retry."
        />
      );

    case 'awaiting_review': {
      const parsed = ProvisioningPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GenerateInfraPlanPanel
            projectId={projectId}
            failedMessage="Saved provisioning plan failed validation. Re-run planning."
          />
        );
      }
      return (
        <ReviewInfraPlanPanel projectId={projectId} plan={parsed.data} />
      );
    }

    case 'approved': {
      const parsed = ProvisioningPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GlassPanel className="border-dashed">
            <p className="text-sm text-rose-300">
              Approved provisioning plan failed validation against the current schema.
            </p>
          </GlassPanel>
        );
      }
      return <ApprovedInfraPlanPanel plan={parsed.data} />;
    }

    default:
      return <GenerateInfraPlanPanel projectId={projectId} />;
  }
}

// Phase 4 (Infrastructure) IaC codegen area. Mirrors SoftwareBuildArea
// but stays scoped to kind='infrastructure'. Routes to
// /infra/build/generate and renders the read-only InfraBuildView.
// The infra pipeline STOPS here in P4-3: preview, provision/apply,
// and runtime are NOT wired for kind='infrastructure'. The agent /
// system / software codegen loaders all 409 an infra project as
// defence in depth.
function InfraBuildArea({
  projectId,
  spec,
  plan,
  build,
  files,
  infraPreview,
  infraPlan,
  infraApply,
  infraDashboard,
}: {
  projectId: string;
  spec: Spec;
  plan: Plan;
  build: Build | null;
  files: BuildFile[];
  infraPreview: PublicInfraPreview | null;
  infraPlan: PublicInfraPlan | null;
  infraApply: PublicInfraApply | null;
  infraDashboard: InfraDashboardPayload | null;
}) {
  const parsedPlan = ProvisioningPlanSchema.safeParse(plan.plan);
  const stepCount = parsedPlan.success ? parsedPlan.data.steps.length : 0;
  const moduleCount = parsedPlan.success
    ? new Set(parsedPlan.data.steps.map((s) => s.module)).size
    : 0;

  // No build yet → render the generate panel.
  if (
    !build ||
    build.kind !== 'infrastructure' ||
    build.status === 'queued' ||
    build.status === 'pending'
  ) {
    return (
      <GenerateInfraBuildPanel
        projectId={projectId}
        stepCount={stepCount}
        moduleCount={moduleCount}
      />
    );
  }

  if (build.status === 'generating') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            composing modules…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          Instantiating vetted catalog modules into Terraform files and
          running a static parse check. No cloud calls, no terraform plan /
          apply.
        </p>
      </GlassPanel>
    );
  }

  if (build.status === 'failed') {
    return (
      <GenerateInfraBuildPanel
        projectId={projectId}
        stepCount={stepCount}
        moduleCount={moduleCount}
        failedMessage="The previous infrastructure codegen attempt failed. You can retry."
      />
    );
  }

  // Build is 'generated'. Read per-file static-check logs + the
  // aggregated secure-default flags out of build.logs (codegen puts
  // them there) and render the read-only InfraBuildView.
  const logs = (build.logs as
    | (BuildLogs & {
        infra_secure_defaults?: {
          private_by_default: boolean;
          tls: boolean;
          least_privilege_iam: boolean;
          kms_encryption: boolean;
        };
        infra_public_opt_ins?: string[];
        infra_module_ids_used?: string[];
        infra_structural_ok?: boolean;
      })
    | null) ?? {};
  const staticChecks =
    (logs.static_checks ?? []).map((c) => ({
      path: c.path,
      status: (c.status as StaticStatus) ?? 'skipped',
      error: c.error,
    })) ?? [];
  const failedCount = staticChecks.filter((c) => c.status === 'failed').length;
  const secureDefaults = logs.infra_secure_defaults ?? {
    private_by_default: true,
    tls: true,
    least_privilege_iam: true,
    kms_encryption: true,
  };
  const publicOptIns = logs.infra_public_opt_ins ?? [];
  const moduleIdsUsed = logs.infra_module_ids_used ?? [];

  const buildView = (
    <InfraBuildView
      files={files}
      staticChecks={staticChecks}
      failedCount={failedCount}
      secureDefaults={secureDefaults}
      publicOptIns={publicOptIns}
      moduleIdsUsed={moduleIdsUsed}
    />
  );

  // build.status === 'generated' → render the preview kick-off panel
  // beneath the build view. The preview is the next gate.
  if (build.status === 'generated') {
    return (
      <>
        {buildView}
        <InfraPreviewPanel projectId={projectId} stepCount={stepCount} />
      </>
    );
  }

  // build.status === 'previewing' → derivation in flight.
  if (build.status === 'previewing') {
    return (
      <>
        {buildView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              deriving preview…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Walking the composed plan + catalog to render the to-be-created
            resources and the cost estimate. No cloud calls.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'previewed' → preview rendered + within budget;
  // mount the real-plan kick-off (or the plan view + confirm gate
  // if a plan row already exists). The P4-5a gate fires from here.
  if (build.status === 'previewed' && infraPreview) {
    return (
      <>
        {buildView}
        <InfraPreviewView preview={infraPreview} />
        {infraPlan ? (
          <>
            <InfraPlanView plan={infraPlan} />
            <InfraConfirmPlanFlow projectId={projectId} plan={infraPlan} />
          </>
        ) : (
          <RunInfraPlanPanel projectId={projectId} stepCount={stepCount} />
        )}
      </>
    );
  }

  // build.status === 'planning' → real plan in flight.
  if (build.status === 'planning') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              terraform plan · running…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Running a real <code className="text-forge-text">terraform plan</code>{' '}
            against your cloud state (read-only). The diff + cost re-check land
            in ~30–90s.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'plan_blocked' → real-plan cost re-check over
  // budget. Surface the plan view (with the OVER_BUDGET banner) plus
  // a retry panel for after the user raises their cap.
  if (build.status === 'plan_blocked') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        {infraPlan ? <InfraPlanView plan={infraPlan} /> : null}
        <RunInfraPlanPanel
          projectId={projectId}
          stepCount={stepCount}
          failedMessage="The real terraform plan came in over budget. Raise the ceiling or trim the spec, then re-run the plan."
        />
      </>
    );
  }

  // build.status === 'plan_confirmed' → the user passed the P4-5a
  // gate; mount the P4-5b apply kick-off panel.
  if (build.status === 'plan_confirmed' && infraPlan) {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        <InfraPlanView plan={infraPlan} />
        <ApplyInfraPanel projectId={projectId} plan={infraPlan} />
      </>
    );
  }

  // build.status === 'applying' → terraform apply in flight (the
  // single write to real cloud). The mid-flight kill-switch watcher
  // is polling on the server.
  if (build.status === 'applying') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        {infraPlan ? <InfraPlanView plan={infraPlan} /> : null}
        <GlassPanel className="border-forge-amber/40 shadow-amber">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              terraform apply · running (the single write to real cloud)
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Applying the confirmed plan. The kill switch can interrupt this
            mid-flight (terraform receives SIGINT and finishes the in-flight
            resource cleanly before stopping). Refresh in ~1–10 minutes.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'provisioned' → apply succeeded; live cloud
  // exists; state encrypted at rest; ledger billed. The MONITOR
  // DASHBOARD (P4-6) is the primary surface; it shows resources +
  // masked outputs + accruing cost vs cap + drift + freeze + gated
  // teardown. Falls back to the older provisioned panel if the
  // dashboard couldn't be assembled (e.g. spec drift).
  if (build.status === 'provisioned' && infraApply && infraPlan) {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        <InfraPlanView plan={infraPlan} />
        {infraDashboard ? (
          <InfraMonitorDashboard payload={infraDashboard} />
        ) : (
          <InfraProvisionedPanel
            projectId={projectId}
            apply={infraApply}
            plan={infraPlan}
          />
        )}
      </>
    );
  }

  // build.status === 'apply_failed' → apply errored or was
  // killswitched; partial state captured; rollback gate.
  if (build.status === 'apply_failed' && infraApply && infraPlan) {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        <InfraPlanView plan={infraPlan} />
        <ApplyFailedPanel
          projectId={projectId}
          apply={infraApply}
          plan={infraPlan}
        />
      </>
    );
  }

  // build.status === 'destroying' → destroy in flight.
  if (build.status === 'destroying') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        {infraPlan ? <InfraPlanView plan={infraPlan} /> : null}
        <GlassPanel className="border-rose-400/40 shadow-amber">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400 shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
              terraform destroy · running
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Tearing down every resource the apply created. Refresh in ~1–10
            minutes.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'destroyed' → teardown complete.
  if (build.status === 'destroyed') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        {infraPlan ? <InfraPlanView plan={infraPlan} /> : null}
        <GlassPanel className="border-rose-400/30">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
            infrastructure · destroyed
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            The teardown completed. The audit record is retained; this build
            is now read-only.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'preview_blocked' → preview rendered + OVER
  // BUDGET; provisioning stays locked. Surface the verdict AND a
  // retry panel for after the user raises the ceiling.
  if (build.status === 'preview_blocked') {
    return (
      <>
        {buildView}
        {infraPreview ? <InfraPreviewView preview={infraPreview} /> : null}
        <InfraPreviewPanel
          projectId={projectId}
          stepCount={stepCount}
          isRetry
        />
      </>
    );
  }

  // Defensive fallback — just the build view.
  return buildView;
}

// Phase 3 (Software) codegen area. Mirrors SystemBuildArea but stays
// scoped to kind='software'. Routes to /software/build/generate and
// renders the read-only SoftwareBuildView. The software pipeline
// STOPS here in this phase: app sandbox test / DB provisioning +
// deploy / runtime are NOT wired for kind='software'. The agent +
// system codegen loaders both 409 a software project as defence in
// depth.
function SoftwareBuildArea({
  projectId,
  projectName,
  spec,
  build,
  files,
  sandboxRun,
  softwareDb,
  supabaseConnection,
  githubConnection,
  githubError,
  vercelConnection,
  vercelError,
  vercelOauthAvailable,
  latestDeployment,
  softwareDashboard,
}: {
  projectId: string;
  projectName: string;
  spec: Spec;
  build: Build | null;
  files: BuildFile[];
  sandboxRun: SandboxRun | null;
  softwareDb: PublicSoftwareDatabase | null;
  supabaseConnection: ConnectionPublic | null;
  githubConnection: ConnectionPublic | null;
  githubError: string | null;
  vercelConnection: ConnectionPublic | null;
  vercelError: string | null;
  vercelOauthAvailable: boolean;
  latestDeployment: Deployment | null;
  softwareDashboard: SoftwareDashboardPayload | null;
}) {
  // Parse the software spec for slot-count framing in the kickoff
  // panel. Falls back to zeros if the schema has drifted (the
  // planner's loader would have refused; defensive parse).
  const parsedSpec = SoftwareSpecSchema.safeParse(spec.structured_spec);
  const pageCount = parsedSpec.success ? parsedSpec.data.pages.length : 0;
  const entityCount = parsedSpec.success ? parsedSpec.data.entities.length : 0;
  const requiresAuth = parsedSpec.success ? parsedSpec.data.auth.requires_auth : true;

  // No build yet, or build belongs to a different plan, or build is
  // queued/awaiting kick-off → render the generate panel.
  if (
    !build ||
    build.kind !== 'software' ||
    build.status === 'queued' ||
    build.status === 'pending'
  ) {
    return (
      <GenerateSoftwareBuildPanel
        projectId={projectId}
        pageCount={pageCount}
        entityCount={entityCount}
      />
    );
  }

  if (build.status === 'generating') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            filling software slots…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          Materialising the Next.js + Supabase scaffold, emitting the RLS
          migration, and filling each LLM slot (API handlers + page
          components). Each file is statically parsed; nothing is executed
          at this layer.
        </p>
      </GlassPanel>
    );
  }

  if (build.status === 'failed') {
    return (
      <GenerateSoftwareBuildPanel
        projectId={projectId}
        pageCount={pageCount}
        entityCount={entityCount}
        failedMessage="The previous software codegen attempt failed. You can retry."
      />
    );
  }

  // Build is generated or further along. Read static-check logs
  // from build.logs (codegen leaves them there); read sandbox
  // phases from sandboxRun.logs (sandbox harness leaves them there).
  const logs = (build.logs as BuildLogs | null) ?? {};
  const staticChecks =
    (logs.static_checks ?? []).map((c) => ({
      path: c.path,
      status: (c.status as StaticStatus) ?? 'skipped',
      error: c.error,
    })) ?? [];
  const warnings = logs.warnings ?? [];
  const failedCount = staticChecks.filter((c) => c.status === 'failed').length;

  const buildView = (
    <SoftwareBuildView
      files={files}
      staticChecks={staticChecks}
      warnings={warnings}
      failedCount={failedCount}
      repoUrl={build.repo_url ?? null}
      deployUrl={build.deploy_url ?? null}
    />
  );

  // build.status === 'generated' → ready to sandbox-test.
  if (build.status === 'generated') {
    return (
      <>
        {buildView}
        <TestSoftwareBuildPanel
          projectId={projectId}
          entityCount={entityCount}
          requiresAuth={requiresAuth}
        />
      </>
    );
  }

  // build.status === 'testing' → in-flight progress strip.
  if (build.status === 'testing') {
    return (
      <>
        {buildView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              software sandbox · running…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Provisioning a disposable sandbox, installing deps, building the
            app with <code className="text-forge-text">next build</code>, then
            standing up an ephemeral Postgres and running the cross-user
            isolation test. Refresh in ~2–4 minutes.
          </p>
        </GlassPanel>
      </>
    );
  }

  // Past testing — render the test view from the sandbox_run row.
  const sandboxLogs = readSoftwareSandboxLogs(sandboxRun);
  const testView = sandboxRun ? (
    <SoftwareTestView
      passed={build.status === 'tested'}
      buildOk={sandboxRun.build_ok ?? null}
      // The software sandbox repurposes smoke_ok for the ISOLATION
      // outcome — see software/sandbox/persistence.ts.
      isolationOk={sandboxRun.smoke_ok ?? null}
      isolation={sandboxLogs.isolation}
      durationMs={sandboxRun.duration_ms ?? null}
      provider={sandboxRun.provider ?? 'unknown'}
      iterations={sandboxRun.iterations ?? 0}
      phases={sandboxLogs.phases}
      lines={sandboxLogs.lines}
      selfHealAttempts={sandboxLogs.selfHealAttempts}
      error={sandboxRun.error ?? null}
    />
  ) : null;

  if (build.status === 'test_failed') {
    return (
      <>
        {buildView}
        {testView}
        <TestSoftwareBuildPanel
          projectId={projectId}
          entityCount={entityCount}
          requiresAuth={requiresAuth}
          isRetry
          failedMessage={
            sandboxRun?.smoke_ok === false
              ? 'Cross-user isolation FAILED — review the migration / spec and re-test. Isolation leaks are not self-healed.'
              : 'The previous sandbox run failed. You can retry.'
          }
        />
      </>
    );
  }

  // build.status === 'tested' → P3-5a DB provisioning gate.
  // build.status === 'provision_failed' → retry the gate with a flash.
  if (build.status === 'tested' || build.status === 'provision_failed') {
    return (
      <>
        {buildView}
        {testView}
        <ProvisionDbFlow
          projectId={projectId}
          projectName={projectName}
          hasSupabaseConnection={Boolean(
            supabaseConnection && supabaseConnection.account_login,
          )}
          entityCount={entityCount}
          failedMessage={
            build.status === 'provision_failed'
              ? 'The previous provisioning attempt failed. You can retry from here.'
              : null
          }
        />
      </>
    );
  }

  // build.status === 'provisioning' — DB call in flight.
  if (build.status === 'provisioning') {
    return (
      <>
        {buildView}
        {testView}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              provisioning database…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Creating the Supabase project (or validating your connection) and
            applying the RLS migration the sandbox already proved isolates
            users cross-account. Refresh in ~30s.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'provisioned' — show the DB recap, then mount
  // the push gate (or the connect-github prompt). Software runtime
  // stays closed until P3-6.
  if (build.status === 'provisioned') {
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        {githubConnection && githubConnection.account_login ? (
          <SoftwareGitHubPushPanel
            projectId={projectId}
            projectName={projectName}
            accountLogin={githubConnection.account_login}
            filesCount={files.length}
            entityCount={entityCount}
          />
        ) : (
          <ConnectGitHubPanel
            projectId={projectId}
            errorFlash={
              githubError ??
              (githubConnection && !githubConnection.account_login
                ? 'connection missing account_login; reconnect'
                : null)
            }
          />
        )}
      </>
    );
  }

  // build.status === 'pushing' — push in flight.
  if (build.status === 'pushing') {
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              pushing app to github…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Creating the private repo and committing every file. Refresh in a
            few seconds.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'push_failed' — retry the push gate.
  if (build.status === 'push_failed') {
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        {githubConnection && githubConnection.account_login ? (
          <SoftwareGitHubPushPanel
            projectId={projectId}
            projectName={projectName}
            accountLogin={githubConnection.account_login}
            filesCount={files.length}
            entityCount={entityCount}
            isRetry
          />
        ) : (
          <ConnectGitHubPanel
            projectId={projectId}
            errorFlash={githubError ?? null}
          />
        )}
      </>
    );
  }

  // From here on the build is past push: 'pushed' / 'deploying' /
  // 'deployed' / 'deploy_failed'. The deploy gate mounts when pushed;
  // runtime activation for kind='software' is NOT wired in this phase.

  if (build.status === 'deploying') {
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              deploying app to vercel…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Uploading the Next.js bundle → setting the wired DB env (anon
            public, service-role server-only · encrypted) → building on Vercel
            → going live. This usually takes 1–3 minutes.
          </p>
        </GlassPanel>
      </>
    );
  }

  // build.status === 'deployed' — Phase 3-6 go-live gate or, if the
  // runtime row already exists in non-stopped state, the app
  // dashboard. The runtime row's existence is the ground truth for
  // "user has authorised live"; a deployed build with no runtime row
  // means "deployed but not yet marked live".
  if (build.status === 'deployed') {
    const liveDashboard = softwareDashboard;
    const hasActiveRuntime =
      liveDashboard?.runtime && liveDashboard.runtime.status !== 'stopped';
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        {build.deploy_url ? (
          <SoftwareDeployedPanel
            deployUrl={build.deploy_url}
            repoUrl={build.repo_url ?? null}
            accountLogin={vercelConnection?.account_login ?? 'unknown'}
            publicEnvKeys={
              (latestDeployment?.env_keys ?? []).filter((k) =>
                k.startsWith('NEXT_PUBLIC_'),
              )
            }
            serverOnlyEnvKeys={
              (latestDeployment?.env_keys ?? []).filter(
                (k) => !k.startsWith('NEXT_PUBLIC_'),
              )
            }
          />
        ) : null}
        {liveDashboard && hasActiveRuntime ? (
          <SoftwareAppDashboard payload={liveDashboard} />
        ) : build.deploy_url ? (
          <SoftwareActivateRuntimeFlow
            projectId={projectId}
            projectName={projectName}
            deployUrl={build.deploy_url}
            entityCount={entityCount}
          />
        ) : null}
      </>
    );
  }

  // build.status === 'running' — software is live. Render the
  // dashboard. If the dashboard payload is missing (edge case after a
  // schema drift), fall back to the deployed panel.
  if (build.status === 'running') {
    return (
      <>
        {buildView}
        {testView}
        {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
        {softwareDashboard ? (
          <SoftwareAppDashboard payload={softwareDashboard} />
        ) : build.deploy_url ? (
          <SoftwareDeployedPanel
            deployUrl={build.deploy_url}
            repoUrl={build.repo_url ?? null}
            accountLogin={vercelConnection?.account_login ?? 'unknown'}
            publicEnvKeys={
              (latestDeployment?.env_keys ?? []).filter((k) =>
                k.startsWith('NEXT_PUBLIC_'),
              )
            }
            serverOnlyEnvKeys={
              (latestDeployment?.env_keys ?? []).filter(
                (k) => !k.startsWith('NEXT_PUBLIC_'),
              )
            }
          />
        ) : null}
      </>
    );
  }

  // build.status === 'pushed' or 'deploy_failed' — render the deploy
  // gate (with a flash on the failed branch). Connect Vercel first if
  // needed.
  const deployFailedFlash =
    build.status === 'deploy_failed'
      ? 'The previous deploy failed. You can retry from here.'
      : null;
  if (build.status === 'pushed' || build.status === 'deploy_failed') {
    if (!vercelConnection) {
      return (
        <>
          {buildView}
          {testView}
          {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
          <ConnectVercelPanel
            projectId={projectId}
            oauthAvailable={vercelOauthAvailable}
            errorFlash={vercelError ?? deployFailedFlash}
          />
        </>
      );
    }
    if (!vercelConnection.account_login) {
      return (
        <>
          {buildView}
          {testView}
          {softwareDb ? <ProvisionedDbPanel db={softwareDb} /> : null}
          <ConnectVercelPanel
            projectId={projectId}
            oauthAvailable={vercelOauthAvailable}
            errorFlash="connection missing account_login; reconnect"
          />
        </>
      );
    }
    if (!softwareDb) {
      // Defensive — a software build at 'pushed' should always have a
      // provisioned-db row. If somehow missing, surface that loudly.
      return (
        <>
          {buildView}
          {testView}
          <GlassPanel className="border-rose-400/30">
            <p className="text-sm text-rose-200">
              Provisioned database record missing — re-run provisioning before
              deploying.
            </p>
          </GlassPanel>
        </>
      );
    }
    return (
      <>
        {buildView}
        {testView}
        <ProvisionedDbPanel db={softwareDb} />
        {deployFailedFlash ? (
          <GlassPanel className="border-rose-400/30">
            <p className="text-sm text-rose-200">{deployFailedFlash}</p>
          </GlassPanel>
        ) : null}
        <SoftwareDeployFlow
          projectId={projectId}
          projectName={projectName}
          accountLogin={vercelConnection.account_login}
          filesCount={files.length}
          supabaseUrl={softwareDb.supabase_url}
          anonKey={softwareDb.anon_key}
          serviceRoleLast4={softwareDb.service_role_last4}
        />
      </>
    );
  }

  // Defensive fallback.
  return (
    <>
      {buildView}
      {testView}
    </>
  );
}

// Read the software sandbox_run's stored payload. Tolerates older
// rows that pre-date the isolation result + self-heal-attempts
// shape — defaults to null / empty array so the UI still renders.
function readSoftwareSandboxLogs(run: SandboxRun | null): {
  phases: Array<{
    phase: 'install' | 'build' | 'smoke' | 'isolation';
    status: 'ok' | 'failed' | 'skipped';
    exit_code: number | null;
    timed_out: boolean;
    duration_ms: number;
    iteration: number;
  }>;
  lines: SandboxLogLine[];
  isolation: {
    outcome: 'passed' | 'failed' | 'errored';
    perEntity: Record<string, { aWrote: number; bSawA: number }>;
    leakTable: string | null;
    leakCount: number;
    errorMessage: string | null;
    vacuous: boolean;
  } | null;
  selfHealAttempts: Array<{
    file_path: string;
    slot_regen_ok: boolean;
    build_ok_after_retry: boolean;
    isolation_ok_after_retry: boolean;
  }>;
} {
  if (!run) {
    return { phases: [], lines: [], isolation: null, selfHealAttempts: [] };
  }
  const payload = (run.logs as {
    phases?: Array<{
      phase: 'install' | 'build' | 'smoke' | 'isolation';
      status: 'ok' | 'failed' | 'skipped';
      exit_code: number | null;
      timed_out: boolean;
      duration_ms: number;
      iteration?: number;
    }>;
    lines?: SandboxLogLine[];
    isolation?: {
      outcome: 'passed' | 'failed' | 'errored';
      perEntity: Record<string, { aWrote: number; bSawA: number }>;
      leakTable: string | null;
      leakCount: number;
      errorMessage: string | null;
      vacuous: boolean;
    } | null;
    selfheal_attempts?: Array<{
      file_path: string;
      slot_regen_ok: boolean;
      build_ok_after_retry: boolean;
      isolation_ok_after_retry: boolean;
    }>;
  } | null) ?? {};
  return {
    phases: (payload.phases ?? []).map((p) => ({
      phase: p.phase,
      status: p.status,
      exit_code: p.exit_code,
      timed_out: p.timed_out,
      duration_ms: p.duration_ms,
      iteration: typeof p.iteration === 'number' ? p.iteration : 0,
    })),
    lines: payload.lines ?? [],
    isolation: payload.isolation ?? null,
    selfHealAttempts: payload.selfheal_attempts ?? [],
  };
}

function PlanArea({
  projectId,
  plan,
}: {
  projectId: string;
  plan: Plan | null;
}) {
  if (!plan || plan.status === 'pending') {
    return <GeneratePlanPanel projectId={projectId} />;
  }

  switch (plan.status) {
    case 'planning':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-cyan shadow-cyan" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              planning…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            The Forge is mapping your spec onto the build pipeline. Refresh if
            it stalls.
          </p>
        </GlassPanel>
      );

    case 'failed':
      return (
        <GeneratePlanPanel
          projectId={projectId}
          failedMessage="The previous planning attempt failed. You can retry."
        />
      );

    case 'awaiting_review': {
      const parsed = BuildPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GeneratePlanPanel
            projectId={projectId}
            failedMessage="Saved plan failed validation. Re-run planning."
          />
        );
      }
      return <ReviewPlanPanel projectId={projectId} plan={parsed.data} />;
    }

    case 'approved': {
      const parsed = BuildPlanSchema.safeParse(plan.plan);
      if (!parsed.success) {
        return (
          <GlassPanel className="border-dashed">
            <p className="text-sm text-rose-300">
              Approved plan failed validation against the current schema.
            </p>
          </GlassPanel>
        );
      }
      return <ApprovedPlanPanel plan={parsed.data} />;
    }

    default:
      return <GeneratePlanPanel projectId={projectId} />;
  }
}

function BuildArea({
  projectId,
  build,
  files,
}: {
  projectId: string;
  build: Build | null;
  files: BuildFile[];
}) {
  if (!build || build.status === 'queued') {
    return <GenerateBuildPanel projectId={projectId} />;
  }

  switch (build.status) {
    case 'generating':
      return (
        <GlassPanel>
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              forging code…
            </p>
          </div>
          <p className="mt-3 text-sm text-forge-dim">
            Materialising the scaffold and generating agent logic. Each file
            is statically parsed — no code is executed at this stage.
          </p>
        </GlassPanel>
      );

    case 'failed':
      return (
        <GenerateBuildPanel
          projectId={projectId}
          failedMessage="The previous codegen attempt failed. You can retry."
        />
      );

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
    case 'running': {
      const logs = (build.logs as BuildLogs | null) ?? {};
      const staticChecks =
        (logs.static_checks ?? []).map((c) => ({
          path: c.path,
          status: (c.status as StaticStatus) ?? 'skipped',
          error: c.error,
        })) ?? [];
      const warnings = logs.warnings ?? [];
      const failedCount = staticChecks.filter((c) => c.status === 'failed').length;
      return (
        <GeneratedBuildPanel
          projectId={projectId}
          files={files}
          staticChecks={staticChecks}
          warnings={warnings}
          failedCount={failedCount}
        />
      );
    }

    default:
      return <GenerateBuildPanel projectId={projectId} />;
  }
}

interface SandboxLogsPayload {
  phases?: Array<{
    phase: 'install' | 'build' | 'smoke';
    status: 'ok' | 'failed' | 'skipped';
    exit_code: number | null;
    timed_out: boolean;
    duration_ms: number;
  }>;
  lines?: SandboxLogLine[];
}

function readSandboxPayload(run: SandboxRun | null): {
  phases: PhaseStatus[];
  lines: SandboxLogLine[];
} {
  if (!run) return { phases: [], lines: [] };
  const logs = (run.logs as SandboxLogsPayload | null) ?? {};
  const phases: PhaseStatus[] = (logs.phases ?? []).map((p) => ({
    phase: p.phase,
    status: p.status,
    exit_code: p.exit_code,
    timed_out: p.timed_out,
    duration_ms: p.duration_ms,
  }));
  return { phases, lines: logs.lines ?? [] };
}

function TestArea({
  projectId,
  build,
  sandboxRun,
}: {
  projectId: string;
  build: Build;
  sandboxRun: SandboxRun | null;
}) {
  if (build.status === 'generated') {
    return <RunTestPanel projectId={projectId} />;
  }

  if (build.status === 'testing') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            sandbox · running…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          The sandbox is sealed. Installing, compiling, and smoke-testing
          the agent with tools in mock mode. The chamber is destroyed when
          the run ends — refresh in ~1–3 minutes.
        </p>
      </GlassPanel>
    );
  }

  const { phases, lines } = readSandboxPayload(sandboxRun);
  const provider = sandboxRun?.provider ?? 'unknown';
  const duration = sandboxRun?.duration_ms ?? null;

  if (build.status === 'tested') {
    return (
      <TestedPanel
        phases={phases}
        lines={lines}
        buildOk={sandboxRun?.build_ok ?? null}
        smokeOk={sandboxRun?.smoke_ok ?? null}
        durationMs={duration}
        provider={provider}
      />
    );
  }

  if (build.status === 'test_failed') {
    return (
      <TestFailedPanel
        projectId={projectId}
        phases={phases}
        lines={lines}
        buildOk={sandboxRun?.build_ok ?? null}
        smokeOk={sandboxRun?.smoke_ok ?? null}
        durationMs={duration}
        provider={provider}
        error={sandboxRun?.error ?? null}
      />
    );
  }

  return null;
}

function PushArea({
  projectId,
  projectName,
  build,
  filesCount,
  githubConnection,
  githubError,
}: {
  projectId: string;
  projectName: string;
  build: Build;
  filesCount: number;
  githubConnection: ConnectionPublic | null;
  githubError: string | null;
}) {
  if (build.status === 'pushed' && build.repo_url) {
    return (
      <PushedPanel
        repoUrl={build.repo_url}
        accountLogin={githubConnection?.account_login ?? 'unknown'}
        filesCount={filesCount}
      />
    );
  }

  if (build.status === 'pushing') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            pushing to github…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          Creating the private repo and committing every file. Refresh in a
          few seconds.
        </p>
      </GlassPanel>
    );
  }

  // tested or push_failed — both go through the gate. Connect first if needed.
  if (!githubConnection) {
    return (
      <ConnectGitHubPanel projectId={projectId} errorFlash={githubError} />
    );
  }
  if (!githubConnection.account_login) {
    return (
      <ConnectGitHubPanel
        projectId={projectId}
        errorFlash="connection missing account_login; reconnect"
      />
    );
  }

  if (build.status === 'push_failed') {
    return (
      <PushFailedPanel
        projectId={projectId}
        projectName={projectName}
        accountLogin={githubConnection.account_login}
        filesCount={filesCount}
        errorMessage={null}
      />
    );
  }

  return (
    <GitHubPushPanel
      projectId={projectId}
      projectName={projectName}
      accountLogin={githubConnection.account_login}
      filesCount={filesCount}
    />
  );
}

function DeployArea({
  projectId,
  projectName,
  build,
  filesCount,
  plan,
  spec,
  githubRepoUrl,
  vercelConnection,
  latestDeployment,
  vercelOauthAvailable,
  vercelError,
}: {
  projectId: string;
  projectName: string;
  build: Build;
  filesCount: number;
  plan: BuildPlan;
  spec: AgentSpec;
  githubRepoUrl: string | null;
  vercelConnection: ConnectionPublic | null;
  latestDeployment: Deployment | null;
  vercelOauthAvailable: boolean;
  vercelError: string | null;
}) {
  // Route always-on / scheduled agents to the (future) runtime layer.
  if (plan.runtime_impl === 'always_on' || spec.trigger === 'schedule') {
    return (
      <DeployBlockedPanel
        runtimeImpl={plan.runtime_impl}
        trigger={spec.trigger}
      />
    );
  }

  if (build.status === 'deployed' && build.deploy_url) {
    return (
      <DeployedPanel
        deployUrl={build.deploy_url}
        repoUrl={githubRepoUrl}
        accountLogin={vercelConnection?.account_login ?? 'unknown'}
        envKeys={latestDeployment?.env_keys ?? []}
      />
    );
  }

  if (build.status === 'deploying') {
    return (
      <GlassPanel>
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            deploying to vercel…
          </p>
        </div>
        <p className="mt-3 text-sm text-forge-dim">
          Uploading files → building on Vercel → going live. This usually
          takes 1–3 minutes. Refresh if it stalls.
        </p>
      </GlassPanel>
    );
  }

  if (!vercelConnection) {
    return (
      <ConnectVercelPanel
        projectId={projectId}
        oauthAvailable={vercelOauthAvailable}
        errorFlash={vercelError}
      />
    );
  }
  if (!vercelConnection.account_login) {
    return (
      <ConnectVercelPanel
        projectId={projectId}
        oauthAvailable={vercelOauthAvailable}
        errorFlash="connection missing account_login; reconnect"
      />
    );
  }

  if (build.status === 'deploy_failed') {
    return (
      <DeployFailedPanel
        projectId={projectId}
        projectName={projectName}
        accountLogin={vercelConnection.account_login}
        filesCount={filesCount}
        envRequired={plan.env_required}
        framework={plan.target.framework}
        errorMessage={null}
        logTail={null}
      />
    );
  }

  // build.status === 'pushed' → present the deploy flow.
  return (
    <DeployFlow
      projectId={projectId}
      projectName={projectName}
      accountLogin={vercelConnection.account_login}
      filesCount={filesCount}
      envRequired={plan.env_required}
      framework={plan.target.framework}
    />
  );
}

function RuntimeArea({
  projectId,
  projectName,
  spec,
  plan,
  runtime,
  runs,
}: {
  projectId: string;
  projectName: string;
  spec: AgentSpec;
  plan: BuildPlan;
  runtime: AgentRuntime | null;
  runs: AgentRun[];
}) {
  if (!runtime || runtime.status === 'stopped') {
    return (
      <ActivateRuntimeFlow
        projectId={projectId}
        projectName={projectName}
        spec={spec}
        plan={plan}
      />
    );
  }
  return <RuntimeView projectId={projectId} runtime={runtime} runs={runs} />;
}
