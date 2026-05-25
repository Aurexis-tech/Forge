// Kill switches. Three scopes: global, user, project. Any active switch
// in the applicable set blocks the action.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type { KillSwitch, KillSwitchScope } from '@/lib/types';

export interface KillScopeQuery {
  userId?: string | null;
  projectId?: string | null;
}

// Returns the highest-precedence active kill switch in the applicable set,
// or null if none active. Global wins, then user, then project.
export async function activeKillSwitch(
  scope: KillScopeQuery,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<KillSwitch | null> {
  const { data, error } = await supabase
    .from('kill_switches')
    .select('*')
    .eq('active', true);
  if (error) throw error;
  const rows = (data ?? []) as KillSwitch[];
  const byScope = (s: KillSwitchScope) => rows.filter((r) => r.scope === s);

  const global = byScope('global')[0];
  if (global) return global;

  if (scope.userId) {
    const user = byScope('user').find((r) => r.scope_id === scope.userId);
    if (user) return user;
  }
  if (scope.projectId) {
    const project = byScope('project').find((r) => r.scope_id === scope.projectId);
    if (project) return project;
  }
  return null;
}

export async function setKillSwitch(
  args: {
    scope: KillSwitchScope;
    scopeId?: string | null;
    reason?: string | null;
    setBy: string;
  },
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<KillSwitch> {
  // De-duplicate: deactivate any existing active row in the same scope, then
  // insert a fresh active one. Keeps a history line.
  const matchScopeId = args.scopeId ?? null;
  const existing = await supabase
    .from('kill_switches')
    .select('id')
    .eq('active', true)
    .eq('scope', args.scope)
    .filter('scope_id', matchScopeId === null ? 'is' : 'eq', matchScopeId ?? '');
  // Supabase doesn't accept null via .eq cleanly; reissue if needed.
  if (matchScopeId === null) {
    await supabase
      .from('kill_switches')
      .update({ active: false })
      .eq('active', true)
      .eq('scope', args.scope)
      .is('scope_id', null);
  } else {
    await supabase
      .from('kill_switches')
      .update({ active: false })
      .eq('active', true)
      .eq('scope', args.scope)
      .eq('scope_id', matchScopeId);
  }
  void existing;

  const { data, error } = await supabase
    .from('kill_switches')
    .insert({
      scope: args.scope,
      scope_id: matchScopeId,
      active: true,
      reason: args.reason ?? null,
      set_by: args.setBy,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to set kill switch');
  return data as KillSwitch;
}

export async function clearKillSwitch(
  args: {
    scope: KillSwitchScope;
    scopeId?: string | null;
    clearedBy: string;
  },
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<void> {
  const matchScopeId = args.scopeId ?? null;
  const base = supabase
    .from('kill_switches')
    .update({ active: false, reason: 'cleared by ' + args.clearedBy })
    .eq('active', true)
    .eq('scope', args.scope);
  const { error } =
    matchScopeId === null
      ? await base.is('scope_id', null)
      : await base.eq('scope_id', matchScopeId);
  if (error) throw error;
}

export async function listKillSwitches(
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<KillSwitch[]> {
  const { data, error } = await supabase
    .from('kill_switches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as KillSwitch[];
}
