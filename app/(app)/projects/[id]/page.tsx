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
import { OrchestrationPlanSchema } from '@/lib/engine/system/planner/schema';
import { SystemSpecSchema } from '@/lib/engine/system/spec';
import { SoftwareConfirmedPanel } from '@/components/software/SoftwareConfirmedPanel';
import { SoftwareReviewPanel } from '@/components/software/SoftwareReviewPanel';
import { ApprovedSoftwarePlanPanel } from '@/components/software/ApprovedSoftwarePlanPanel';
import { GenerateSoftwarePlanPanel } from '@/components/software/GenerateSoftwarePlanPanel';
import { ReviewSoftwarePlanPanel } from '@/components/software/ReviewSoftwarePlanPanel';
import { SoftwareBuildPlanSchema } from '@/lib/engine/software/planner/schema';
import { SoftwareSpecSchema } from '@/lib/engine/software/spec';
import { InfraConfirmedPanel } from '@/components/infra/InfraConfirmedPanel';
import { InfraReviewPanel } from '@/components/infra/InfraReviewPanel';
import { ApprovedInfraPlanPanel } from '@/components/infra/ApprovedInfraPlanPanel';
import { GenerateInfraPlanPanel } from '@/components/infra/GenerateInfraPlanPanel';
import { ReviewInfraPlanPanel } from '@/components/infra/ReviewInfraPlanPanel';
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

      // Runtime: always look up when build is pushed/running. Even a
      // 'stopped' runtime row is useful for showing run history.
      if (build.status === 'pushed' || build.status === 'running') {
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

      {build &&
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
    </section>
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
          <InfraReviewPanel projectId={projectId} spec={parsedInfra.data} />
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
          <SoftwareReviewPanel projectId={projectId} spec={parsedSw.data} />
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
          <SystemReviewPanel projectId={projectId} spec={parsedSys.data} />
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
      return <ReviewPanel projectId={projectId} spec={parsed.data} />;
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
      return (
        <ReviewOrchestrationPanel projectId={projectId} plan={parsed.data} />
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
      return <ApprovedOrchestrationPanel plan={parsed.data} />;
    }

    default:
      return <GenerateOrchestrationPanel projectId={projectId} />;
  }
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
