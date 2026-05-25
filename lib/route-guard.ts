// Reusable route entry-guard. Collapses the (auth → ownership → governance)
// pattern every project-scoped route would otherwise re-implement.
//
// Usage:
//   const guard = await projectRouteGuard(params.id, { projectedCostUsd: 0.05 });
//   if ('error' in guard) {
//     return NextResponse.json(guard.body, { status: guard.status });
//   }
//   const { user, project } = guard;
//
// The route then runs its actual logic with confidence that:
//   1. The caller is authenticated.
//   2. They own the project.
//   3. No kill switch is active for their scope.
//   4. They have budget headroom for `projectedCostUsd`.

import {
  requireProjectOwnership,
  requireUser,
  UnauthorizedError,
  type AuthedUser,
} from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import { userHasAnyByok } from '@/lib/engine/keys';
import type { Project } from '@/lib/types';

export interface ProjectRouteGuardOptions {
  // Optional projected cost (USD) for the guard's budget check. Defaults
  // to 0 — actions that don't spend money still benefit from the kill-
  // switch + ownership checks.
  projectedCostUsd?: number;
}

export type ProjectRouteGuardResult =
  | { user: AuthedUser; project: Project }
  | { error: string; status: number; body: Record<string, unknown> };

export async function projectRouteGuard(
  projectId: string,
  opts: ProjectRouteGuardOptions = {},
): Promise<ProjectRouteGuardResult> {
  // 1. Auth.
  let user: AuthedUser;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return {
        error: 'not signed in',
        status: 401,
        body: { error: 'not signed in' },
      };
    }
    throw err;
  }

  // 2. Ownership.
  const ownership = await requireProjectOwnership(projectId, user);
  if ('error' in ownership) {
    return {
      error: ownership.error,
      status: ownership.status,
      body: { error: ownership.error },
    };
  }

  // 3. Governance (kill switch + budget headroom).
  // Peek at the user's BYOK keys so a self-funded user isn't blocked by
  // the platform's budget cap at the route entry. The per-call guard
  // inside the LLM / sandbox layer still runs the exact-source check.
  const byok = await userHasAnyByok(user.id, ['anthropic', 'e2b']);
  const keySource = byok ? 'byok' : 'platform';
  try {
    await assertAllowed({
      user_id: user.id,
      project_id: projectId,
      projectedCostUsd: opts.projectedCostUsd ?? 0,
      keySource,
    });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return { error: body.error, status, body };
    }
    throw err;
  }

  return { user, project: ownership.project };
}
