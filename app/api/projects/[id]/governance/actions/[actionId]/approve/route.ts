import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireProjectOwnership,
  requireUser,
  UnauthorizedError,
} from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import {
  approveGovernedAction,
  GovernedActionNotPendingError,
} from '@/lib/engine/governance/broker';

export const runtime = 'nodejs';
export const maxDuration = 60;

// The human approval of a held runtime governed action. Mirrors the
// build-time push/deploy gate: it REQUIRES { authorized: true } as the
// in-flight expression of consent, and ONLY this route causes Forge to
// perform the real send with the server-held credential.
const BodySchema = z.object({ authorized: z.literal(true) });

interface RouteContext {
  params: { id: string; actionId: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const ownership = await requireProjectOwnership(params.id, user);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }

  // Approving performs a real, credentialed side-effect under the user's
  // account — gate it on the kill switch + budget, same as the push gate.
  try {
    await assertAllowed({ user_id: user.id, project_id: params.id, projectedCostUsd: 0 });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!BodySchema.safeParse(body).success) {
    return NextResponse.json(
      {
        error:
          'request body must include { "authorized": true } — the user must explicitly approve the governed action',
      },
      { status: 403 },
    );
  }

  try {
    const result = await approveGovernedAction({
      actionId: params.actionId,
      projectId: params.id,
      actor: 'user',
    });
    if (result.status === 'failed') {
      // The send was attempted on approval but the provider/credential
      // failed. Honest 502 — the action is recorded 'failed', not sent.
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof GovernedActionNotPendingError) {
      return NextResponse.json(
        { error: 'action is not pending', status: err.currentStatus },
        { status: 409 },
      );
    }
    throw err;
  }
}
