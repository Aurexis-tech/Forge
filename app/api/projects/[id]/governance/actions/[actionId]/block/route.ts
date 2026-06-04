import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireProjectOwnership,
  requireUser,
  UnauthorizedError,
} from '@/lib/auth';
import {
  blockGovernedAction,
  GovernedActionNotPendingError,
} from '@/lib/engine/governance/broker';

export const runtime = 'nodejs';
export const maxDuration = 30;

// The human blocks a held runtime governed action. Blocking is the SAFE
// direction, so — unlike approve — it is NOT gated on the kill switch /
// budget: you can always refuse a held action. It NEVER performs the send.
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
          'request body must include { "authorized": true } — the user must explicitly confirm the block',
      },
      { status: 403 },
    );
  }

  try {
    const result = await blockGovernedAction({
      actionId: params.actionId,
      projectId: params.id,
      actor: 'user',
    });
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
