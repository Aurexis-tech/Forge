import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';
import { loadLatestSpec, confirmSpec } from '@/lib/engine/spec/persistence';
import { AgentSpecSchema } from '@/lib/engine/spec/schema';
import { confirmSystemSpec } from '@/lib/engine/system/persistence';
import { SystemSpecSchema } from '@/lib/engine/system/spec';
import { confirmSoftwareSpec } from '@/lib/engine/software/persistence';
import { SoftwareSpecSchema } from '@/lib/engine/software/spec';
import { confirmInfraSpec } from '@/lib/engine/infra/persistence';
import { InfraSpecSchema } from '@/lib/engine/infra/spec';

export const runtime = 'nodejs';

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  const guard = await projectRouteGuard(projectId);
  if ('error' in guard) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const supabase = getServerSupabase();

  const spec = await loadLatestSpec(supabase, projectId);
  if (!spec) {
    return NextResponse.json({ error: 'project has no spec row' }, { status: 404 });
  }
  if (spec.status !== 'awaiting_review') {
    return NextResponse.json(
      {
        error:
          `spec is in status '${spec.status}'; only 'awaiting_review' can be confirmed`,
      },
      { status: 409 },
    );
  }

  // Phase 2/3/4: branch on the spec's `kind` discriminator. Each kind
  // has its own Zod schema + confirm helper; the state machine itself
  // (pending → ... → confirmed) is shared.
  if (spec.kind === 'infrastructure') {
    const validation = InfraSpecSchema.safeParse(spec.structured_spec);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'stored InfraSpec no longer matches the current schema',
          detail: validation.error.issues.slice(0, 4),
        },
        { status: 422 },
      );
    }
    try {
      const confirmed = await confirmInfraSpec(supabase, spec);
      return NextResponse.json({
        status: 'confirmed',
        kind: 'infrastructure',
        spec: confirmed,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'failed to confirm infrastructure spec';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (spec.kind === 'software') {
    const validation = SoftwareSpecSchema.safeParse(spec.structured_spec);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'stored SoftwareSpec no longer matches the current schema',
          detail: validation.error.issues.slice(0, 4),
        },
        { status: 422 },
      );
    }
    try {
      const confirmed = await confirmSoftwareSpec(supabase, spec);
      return NextResponse.json({
        status: 'confirmed',
        kind: 'software',
        spec: confirmed,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'failed to confirm software spec';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (spec.kind === 'system') {
    const validation = SystemSpecSchema.safeParse(spec.structured_spec);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'stored SystemSpec no longer matches the current schema',
          detail: validation.error.issues.slice(0, 4),
        },
        { status: 422 },
      );
    }
    try {
      const confirmed = await confirmSystemSpec(supabase, spec);
      return NextResponse.json({
        status: 'confirmed',
        kind: 'system',
        spec: confirmed,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'failed to confirm system spec';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Default / 'agent' path — unchanged.
  const validation = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!validation.success) {
    return NextResponse.json(
      {
        error: 'stored spec no longer matches the current schema',
        detail: validation.error.issues.slice(0, 4),
      },
      { status: 422 },
    );
  }

  try {
    const confirmed = await confirmSpec(supabase, spec);
    return NextResponse.json({
      status: 'confirmed',
      kind: 'agent',
      spec: confirmed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to confirm spec';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
