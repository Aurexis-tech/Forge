// ADMIN-DASHBOARD — the policy-behaviour PROOF (the centerpiece).
//
// HERMETIC: runs the GENERATED admin migration inside in-process pglite
// (real Postgres in WASM — no network, no service, no real Supabase). A
// shim simulates auth.uid()/auth.role()/auth.jwt() from runtime GUCs, so
// the admin claim (app_metadata.role) is set per query. We prove the
// admin-read RLS policy behaves correctly, directly against the real
// emitted SQL:
//
//   1. NON-ADMIN reads      -> sees ONLY own rows (admin clause false -> owner clause)
//   2. ADMIN reads          -> sees ALL rows (own + others')
//   3. user_metadata-admin  -> sees ONLY own rows  <-- THE ESCALATION PATH, CLOSED
//                              (policy reads app_metadata, NOT user_metadata)
//   4. ADMIN writes         -> CANNOT update/delete others' rows (read-only admin;
//                              no admin write policy, owner policy still scopes writes)
//
// DEFERRED real-run check (small, documented): that real Supabase carries
// the role in the JWT app_metadata and the server session reads it. The
// policy LOGIC is proven here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { emitSoftwareMigration } from '@/lib/engine/software/codegen/migration';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

function adminSpec(): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A notes app with an admin dashboard.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    admin_dashboard: { entities: ['Note'] },
  });
}

let db: PGlite;
const A = randomUUID();
const B = randomUUID();

beforeAll(async () => {
  db = new PGlite();

  // --- Supabase auth shim — EXACTLY mirrors the sandbox isolation driver's
  // shim (auth.uid/role/jwt read runtime GUCs). auth.jwt() reads
  // request.jwt.claims, so the admin claim is simulatable per query.
  await db.exec('create schema if not exists auth;');
  await db.exec(
    "create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;",
  );
  await db.exec(
    "create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'anon') $$;",
  );
  await db.exec(
    "create or replace function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;",
  );
  await db.exec('create table if not exists auth.users (id uuid primary key default gen_random_uuid());');

  // --- apply the REAL generated migration (owner policy + admin-read policy) ---
  await db.exec(emitSoftwareMigration(adminSpec()));

  // --- non-privileged role so RLS is enforced (superuser bypasses RLS) ---
  await db.exec('create role authenticated nologin;');
  await db.exec('grant select, insert, update, delete on public.note to authenticated;');

  // --- seed: A owns a row, B owns a row (each inserted as themselves) ---
  await db.query('insert into auth.users (id) values ($1),($2)', [A, B]);
  await db.exec('begin');
  await db.exec("set local app.uid = '" + A + "'");
  await db.exec('set local role authenticated');
  await db.query("insert into public.note (owner_id, title) values ($1, 'a-note')", [A]);
  await db.exec('commit');
  await db.exec('begin');
  await db.exec("set local app.uid = '" + B + "'");
  await db.exec('set local role authenticated');
  await db.query("insert into public.note (owner_id, title) values ($1, 'b-note')", [B]);
  await db.exec('commit');
});

afterAll(async () => {
  await db?.close();
});

// Count A's rows visible to a reader with the given uid + JWT claims.
async function rowsOfAVisibleTo(uid: string, claims: object | null): Promise<number> {
  await db.exec('begin');
  await db.exec("set local app.uid = '" + uid + "'");
  await db.exec("set local request.jwt.claims = '" + (claims ? JSON.stringify(claims) : '') + "'");
  await db.exec('set local role authenticated');
  const r = await db.query<{ n: number }>(
    'select count(*)::int as n from public.note where owner_id = $1',
    [A],
  );
  await db.exec('commit');
  return r.rows[0]!.n;
}

describe('admin-dashboard RLS policy — proven against the generated migration', () => {
  it('1. a NON-ADMIN sees ONLY their own rows (admin clause false -> owner clause)', async () => {
    // B, no admin claim: must see 0 of A's rows.
    expect(await rowsOfAVisibleTo(B, null)).toBe(0);
  });

  it("2. an ADMIN (app_metadata.role='admin') sees ALL rows, including others'", async () => {
    // B, admin via SERVER-CONTROLLED app_metadata: sees A's row.
    expect(await rowsOfAVisibleTo(B, { app_metadata: { role: 'admin' } })).toBe(1);
  });

  it('3. ESCALATION CLOSED: a user who sets their OWN user_metadata.role=admin still sees ONLY their own rows', async () => {
    // user_metadata is user-editable; the policy reads app_metadata, so this
    // self-promotion attempt grants NOTHING. This is the most important case.
    expect(await rowsOfAVisibleTo(B, { user_metadata: { role: 'admin' } })).toBe(0);
    // Belt-and-braces: a role claim at the TOP level (not under app_metadata)
    // is also ignored.
    expect(await rowsOfAVisibleTo(B, { role: 'admin' })).toBe(0);
  });

  it('4. READ-ONLY admin: an admin CANNOT update or delete another user\'s rows', async () => {
    // The admin-read policy is `for select` only; writes fall through to the
    // owner `for all` policy, which scopes them to the writer's own rows.
    await db.exec('begin');
    await db.exec("set local app.uid = '" + B + "'");
    await db.exec("set local request.jwt.claims = '" + JSON.stringify({ app_metadata: { role: 'admin' } }) + "'");
    await db.exec('set local role authenticated');
    const upd = await db.query("update public.note set title = 'hacked' where owner_id = $1 returning id", [A]);
    const del = await db.query('delete from public.note where owner_id = $1 returning id', [A]);
    await db.exec('commit');
    expect(upd.rows).toHaveLength(0); // 0 of A's rows updated by admin B
    expect(del.rows).toHaveLength(0); // 0 of A's rows deleted by admin B
  });
});
