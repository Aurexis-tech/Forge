import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { assertAllowed, GovernanceError, governanceBlockResponse } from '@/lib/engine/governance/guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// Derive a short, friendly project name from the raw prompt.
function nameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
  if (!words) return 'Untitled forge';
  // Capitalise the first letter for display.
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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

  // Project creation itself doesn't burn money but kill switches still
  // apply. Pass 0 projected cost.
  try {
    await assertAllowed({ user_id: user.id, projectedCostUsd: 0 });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  let body: { raw_prompt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const rawPrompt =
    typeof body.raw_prompt === 'string' ? body.raw_prompt.trim() : '';
  if (!rawPrompt) {
    return NextResponse.json(
      { error: 'raw_prompt is required' },
      { status: 400 },
    );
  }
  if (rawPrompt.length > 8000) {
    return NextResponse.json(
      { error: 'raw_prompt too long' },
      { status: 413 },
    );
  }

  const supabase = getServerSupabase();
  const name = nameFromPrompt(rawPrompt);

  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .insert({ name, status: 'draft', user_id: user.id })
    .select('*')
    .single();

  if (projectErr || !project) {
    return NextResponse.json(
      { error: projectErr?.message ?? 'failed to create project' },
      { status: 500 },
    );
  }

  const { error: specErr } = await supabase.from('specs').insert({
    project_id: project.id,
    raw_prompt: rawPrompt,
    status: 'pending',
  });

  if (specErr) {
    // Best-effort cleanup so we don't leave an orphan project.
    await supabase.from('projects').delete().eq('id', project.id);
    return NextResponse.json({ error: specErr.message }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: project.id,
    action: 'project.created',
    actor: 'user',
    detail: { name, prompt_chars: rawPrompt.length, user_id: user.id },
  });

  return NextResponse.json({ project }, { status: 201 });
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ projects: data ?? [] });
}
