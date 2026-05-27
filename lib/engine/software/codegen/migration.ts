// Aurexis Forge — Phase 3 (Software) deterministic migration emit.
//
// The schema layer's `entity_migration` + `rls_policy` slots are
// NEVER LLM-filled. This module walks the confirmed SoftwareSpec's
// entities and produces a single canonical SQL migration with:
//
//   - one `create table` per entity (typed columns from FIELD_TYPES)
//   - one `alter table ... enable row level security` per entity
//   - one `create policy` per entity scoped to the row owner when
//     SoftwareSpec.auth.per_user_isolation is true, or a permissive
//     "authenticated user" policy when it isn't (and auth is on)
//   - one `create policy` for the anon case when auth.requires_auth
//     is false — read-only public access, no writes
//
// Non-negotiable #2 — RLS on by default — is enforced HERE. There is
// no code path through the codegen pipeline that writes a migration
// without an `enable row level security` line per entity table. Tests
// in tests/e2e/software-codegen-dryrun.test.ts assert this directly.

import type { SoftwareSpec } from '../spec';

// Map the spec's narrow field-type vocabulary onto Postgres column
// types. Closed catalog ↔ closed mapping; the LLM never picks types.
const SQL_TYPE: Record<string, string> = {
  string: 'text',
  text: 'text',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  email: 'text',
  url: 'text',
  enum: 'text',
  reference: 'uuid',
};

// PascalCase entity name → snake_case table name. Mechanical.
function tableName(entity: string): string {
  return entity
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

export function emitSoftwareMigration(spec: SoftwareSpec): string {
  const lines: string[] = [];
  lines.push(
    '-- Aurexis Forge — generated migration for ' +
      spec.goal.replace(/\n/g, ' ').slice(0, 160),
  );
  lines.push("-- This file is template-emitted, NOT LLM-authored.");
  lines.push("-- RLS is enabled on every entity table by construction.");
  lines.push('');

  for (const entity of spec.entities) {
    const table = tableName(entity.name);
    lines.push('-- ' + entity.name);
    lines.push('create table if not exists public.' + table + ' (');
    lines.push('  id uuid primary key default gen_random_uuid(),');
    // Owner column is ALWAYS present when auth is on so RLS policies
    // can pin rows to a user. Even when per_user_isolation is off, a
    // populated owner_id helps audit + future feature work.
    if (spec.auth.requires_auth) {
      lines.push('  owner_id uuid not null references auth.users(id) on delete cascade,');
    }
    for (const field of entity.fields) {
      const sqlType = SQL_TYPE[field.type] ?? 'text';
      // Field names are already lower_snake_case by schema.
      lines.push('  ' + field.name + ' ' + sqlType + ',');
    }
    lines.push('  created_at timestamptz not null default now()');
    lines.push(');');
    lines.push('');

    // RLS — non-negotiable. Always enable; the policy varies by auth
    // posture, but the `enable row level security` line is unconditional.
    lines.push('alter table public.' + table + ' enable row level security;');

    // Drop-then-create so re-runs are idempotent. Policy names are
    // table-scoped so they don't collide across migrations.
    if (spec.auth.requires_auth && spec.auth.per_user_isolation) {
      // Per-user RLS: each user sees + writes only their own rows.
      lines.push(
        'drop policy if exists ' + table + '_owner on public.' + table + ';',
      );
      lines.push(
        'create policy ' +
          table +
          '_owner on public.' +
          table +
          ' for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());',
      );
    } else if (spec.auth.requires_auth) {
      // Shared-view auth: every signed-in user sees + writes every row.
      // This is the "team-tool" shape — auth gates the door, not the rows.
      lines.push(
        'drop policy if exists ' + table + '_authed on public.' + table + ';',
      );
      lines.push(
        'create policy ' +
          table +
          '_authed on public.' +
          table +
          ' for all using (auth.role() = ' +
          "'authenticated'" +
          ') with check (auth.role() = ' +
          "'authenticated'" +
          ');',
      );
    } else {
      // Public-no-auth app: read-only access to anon (no writes), so
      // the database itself stops a hostile client from inserting.
      lines.push(
        'drop policy if exists ' + table + '_public_read on public.' + table + ';',
      );
      lines.push(
        'create policy ' +
          table +
          '_public_read on public.' +
          table +
          ' for select to anon using (true);',
      );
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

export function migrationPath(): string {
  // Single migration file for the generated app's schema. The Forge's
  // own migrations live under supabase/migrations/0001_*.sql etc; the
  // GENERATED app gets its own 0001 inside its own project tree.
  return 'supabase/migrations/0001_init.sql';
}

// Expose the table-name helper so the per-slot generator can refer to
// the same table names in API + UI prompts without re-deriving.
export { tableName };
