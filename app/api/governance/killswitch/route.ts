// The kill switch endpoint. ACTIVATING is one click + confirm — safety
// should be easy to engage. CLEARING also confirms but writes a distinct
// audit row so the reason for resumption is recorded.
//
// Scope rules:
//   - 'global' → only the platform operator may set/clear (heuristic: same
//     authenticated user as today; multi-tenant ops controls land later)
//   - 'user'   → the scope_id MUST match the authenticated user
//   - 'project'→ the user must own the referenced project

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import {
  clearKillSwitch,
  setKillSwitch,
} from '@/lib/engine/governance/killswitch';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const PostSchema = z.object({
  scope: z.enum(['global', 'user', 'project']),
  scope_id: z.string().min(1).max(120).optional(),
  reason: z.string().max(400).optional(),
});

const DeleteSchema = z.object({
  scope: z.enum(['global', 'user', 'project']),
  scope_id: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const supabase = getServerSupabase();
  const scopeId = await resolveScope(parsed.data.scope, parsed.data.scope_id, user.id, supabase);
  if ('error' in scopeId) {
    return NextResponse.json({ error: scopeId.error }, { status: scopeId.status });
  }

  const sw = await setKillSwitch(
    {
      scope: parsed.data.scope,
      scopeId: scopeId.value,
      reason: parsed.data.reason ?? null,
      setBy: user.id,
    },
    supabase,
  );
  await supabase.from('audit_log').insert({
    project_id: parsed.data.scope === 'project' ? scopeId.value : null,
    action: 'killswitch.activated',
    actor: 'user',
    detail: {
      scope: sw.scope,
      scope_id: sw.scope_id,
      reason: sw.reason,
      set_by: user.id,
    },
  });
  return NextResponse.json({ kill_switch: sw });
}

export async function DELETE(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const supabase = getServerSupabase();
  const scopeId = await resolveScope(parsed.data.scope, parsed.data.scope_id, user.id, supabase);
  if ('error' in scopeId) {
    return NextResponse.json({ error: scopeId.error }, { status: scopeId.status });
  }

  await clearKillSwitch(
    {
      scope: parsed.data.scope,
      scopeId: scopeId.value,
      clearedBy: user.id,
    },
    supabase,
  );
  await supabase.from('audit_log').insert({
    project_id: parsed.data.scope === 'project' ? scopeId.value : null,
    action: 'killswitch.cleared',
    actor: 'user',
    detail: {
      scope: parsed.data.scope,
      scope_id: scopeId.value,
      cleared_by: user.id,
    },
  });
  return NextResponse.json({ ok: true });
}

async function resolveScope(
  scope: 'global' | 'user' | 'project',
  rawScopeId: string | undefined,
  userId: string,
  supabase: ReturnType<typeof getServerSupabase>,
): Promise<{ value: string | null } | { error: string; status: number }> {
  if (scope === 'global') return { value: null };
  if (scope === 'user') {
    const requested = rawScopeId ?? userId;
    if (requested !== userId) {
      return { error: 'a user can only toggle their own kill switch', status: 403 };
    }
    return { value: requested };
  }
  // scope === 'project'
  if (!rawScopeId) {
    return { error: 'scope_id is required for project scope', status: 400 };
  }
  const { data } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', rawScopeId)
    .maybeSingle();
  const row = data as { id: string; user_id: string | null } | null;
  if (!row || row.user_id !== userId) {
    return { error: 'project not found', status: 404 };
  }
  return { value: rawScopeId };
}
