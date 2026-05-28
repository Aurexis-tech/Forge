// File-upload slot — owner-scoped private file storage.
//
// Hermetic, no LLM. Proves the slot's STRUCTURAL guarantees:
//   - private bucket + vetted owner-scoped storage RLS policy (byte-
//     identical, never reaches the LLM)
//   - owner-scoped metadata table (DB) — covered by the pglite isolation
//     test, exactly like a declared entity
//   - server-enforced size + content-type validation -> typed bad_input
//   - signed-URL-only download (no public URL, short-lived)
//
// EXPLICIT TEST BOUNDARY: the metadata table's DB isolation is hermetically
// tested (entitiesToIsolate + owner-scoped migration); the STORAGE-level
// isolation (B can't download A's actual files) is NOT hermetically
// testable (pglite is DB-only, no Supabase Storage). It is proven
// STRUCTURALLY here (the vetted policy text) and the runtime proof is a
// DEFERRED real-Supabase-run validation item — asserted as a documented
// boundary below, not a silent gap.

import { describe, expect, it } from 'vitest';
import {
  expandFileUpload,
  emitStorageMigration,
  emitUploadPolicyFile,
  emitUploadRoute,
  emitSignedUrlRoute,
  validateUpload,
  fileUploadSlots,
  fileUploadGalleryPages,
  fileUploadMetadataEntities,
  STORAGE_BUCKET_ID,
  STORAGE_MIGRATION_PATH,
} from '@/lib/engine/software/codegen/file-upload';
import { emitSoftwareMigration } from '@/lib/engine/software/codegen/migration';
import { entitiesToIsolate } from '@/lib/engine/software/sandbox/isolation';
import { deriveSoftwareGraph } from '@/lib/engine/software/planner/graph';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';
import { EngineError } from '@/lib/engine/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function uploadSpec(over: Partial<SoftwareSpec> = {}): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A notes app with image attachments.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    file_uploads: [
      { name: 'Attachment', max_size_mb: 5, content_types: ['image/png', 'image/jpeg'] },
    ],
    ...over,
  });
}

const SLOT = { name: 'Attachment', slug: 'attachment', maxSizeMb: 5, contentTypes: ['image/png', 'image/jpeg'] };

// ===========================================================================
// COMPOSITE EXPANSION
// ===========================================================================
describe('expandFileUpload — deterministic atomic-slot set', () => {
  it('expands into bucket + storage policy + metadata table + upload policy + upload route + signed-url route + gallery page', () => {
    const exp = expandFileUpload(SLOT);
    const kinds = exp.slots.map((s) => s.kind);
    expect(kinds).toEqual([
      'storage_bucket',
      'storage_policy',
      'metadata_table',
      'upload_policy',
      'upload_route',
      'signed_url_route',
      'gallery_page',
    ]);
    // Bucket is PRIVATE.
    expect(exp.bucket).toEqual({ id: STORAGE_BUCKET_ID, public: false });
    // Everything is structural EXCEPT the incidental gallery page.
    const structuralKinds = exp.slots.filter((s) => s.structural).map((s) => s.kind);
    expect(structuralKinds).toEqual([
      'storage_bucket',
      'storage_policy',
      'metadata_table',
      'upload_policy',
      'upload_route',
      'signed_url_route',
    ]);
    expect(exp.slots.find((s) => s.kind === 'gallery_page')!.structural).toBe(false);
    // Paths.
    expect(exp.slots.find((s) => s.kind === 'upload_route')!.path).toBe('app/api/uploads/attachment/route.ts');
    expect(exp.slots.find((s) => s.kind === 'signed_url_route')!.path).toBe('app/api/uploads/attachment/[id]/route.ts');
  });

  it('is deterministic', () => {
    expect(expandFileUpload(SLOT)).toEqual(expandFileUpload(SLOT));
  });

  it('fileUploadSlots normalises spec.file_uploads; gallery pages are derived', () => {
    const slots = fileUploadSlots(uploadSpec());
    expect(slots).toHaveLength(1);
    expect(slots[0]!.slug).toBe('attachment');
    const pages = fileUploadGalleryPages(uploadSpec());
    expect(pages[0]!.id).toBe('attachment_files');
  });
});

// ===========================================================================
// STRUCTURAL STORAGE SECURITY
// ===========================================================================
describe('storage migration is the vetted owner-scoped policy (structural)', () => {
  it('emits a PRIVATE bucket + owner-scoped RLS on storage.objects', () => {
    const sql = emitStorageMigration(uploadSpec());
    // Private bucket — public = false.
    expect(sql).toContain("insert into storage.buckets (id, name, public) values ('user_files', 'user_files', false)");
    // Owner-scoped policy keyed on the owner-id path prefix.
    expect(sql).toContain("(storage.foldername(name))[1] = auth.uid()::text");
    expect(sql).toContain("bucket_id = 'user_files'");
    // All four operations are policed.
    expect(sql).toContain('user_files_select on storage.objects for select');
    expect(sql).toContain('user_files_insert on storage.objects for insert');
    expect(sql).toContain('user_files_update on storage.objects for update');
    expect(sql).toContain('user_files_delete on storage.objects for delete');
    // NEVER public.
    expect(sql).not.toContain("public) values ('user_files', 'user_files', true)");
  });

  it('is byte-identical regardless of anything external (no LLM input)', () => {
    expect(emitStorageMigration(uploadSpec())).toBe(emitStorageMigration(uploadSpec()));
  });

  it('lands in a SEPARATE 0002_storage.sql (not 0001 — keeps the DB-only pglite test honest)', () => {
    expect(STORAGE_MIGRATION_PATH).toBe('supabase/migrations/0002_storage.sql');
  });

  it('DOCUMENTS the deferred real-run storage-isolation check (not a silent gap)', () => {
    const sql = emitStorageMigration(uploadSpec());
    expect(sql.toLowerCase()).toContain('deferred');
    expect(sql.toLowerCase()).toContain('not covered');
  });

  it('emits nothing when the spec declares no file uploads (backward-compat)', () => {
    const spec = SoftwareSpecSchema.parse({
      goal: 'plain',
      pages: [{ id: 'home', name: 'Home', purpose: 'home' }],
      entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
      flows: [],
      auth: { requires_auth: true, per_user_isolation: true },
    });
    expect(emitStorageMigration(spec)).toBe('');
  });
});

// ===========================================================================
// METADATA TABLE — DB owner-scoping (hermetically isolation-tested)
// ===========================================================================
describe('metadata table is owner-scoped + covered by the DB isolation test', () => {
  it('the metadata table is in the pglite isolation set', () => {
    expect(entitiesToIsolate(uploadSpec())).toContain('attachment');
  });

  it('the 0001 migration gives the metadata table owner_id + RLS + the fixed fields', () => {
    const sql = emitSoftwareMigration(uploadSpec());
    expect(sql).toContain('create table if not exists public.attachment');
    expect(sql).toContain('alter table public.attachment enable row level security;');
    expect(sql).toContain('create policy attachment_owner on public.attachment');
    expect(sql).toContain('owner_id = auth.uid()');
    // Fixed metadata columns.
    expect(sql).toContain('path text');
    expect(sql).toContain('filename text');
    expect(sql).toContain('size numeric');
    expect(sql).toContain('content_type text');
  });

  it('fileUploadMetadataEntities exposes the synthetic metadata entity', () => {
    const ents = fileUploadMetadataEntities(uploadSpec());
    expect(ents).toHaveLength(1);
    expect(ents[0]!.name).toBe('Attachment');
    expect(ents[0]!.fields.map((f) => f.name).sort()).toEqual([
      'content_type',
      'filename',
      'path',
      'size',
    ]);
  });
});

// ===========================================================================
// SERVER-ENFORCED VALIDATION
// ===========================================================================
describe('upload validation is server-enforced (typed bad_input)', () => {
  const policy = { maxSizeMb: 5, contentTypes: ['image/png', 'image/jpeg'] };

  function expectBadInput(fn: () => unknown, code: string) {
    try {
      fn();
      expect.fail('expected a bad_input EngineError');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe(code);
    }
  }

  it('accepts a valid upload', () => {
    expect(() => validateUpload(policy, { size: 1024, contentType: 'image/png' })).not.toThrow();
  });

  it('rejects an over-size upload -> upload_too_large', () => {
    expectBadInput(
      () => validateUpload(policy, { size: 6 * 1024 * 1024, contentType: 'image/png' }),
      'upload_too_large',
    );
  });

  it('rejects a disallowed content-type -> upload_content_type_not_allowed', () => {
    expectBadInput(
      () => validateUpload(policy, { size: 1024, contentType: 'application/x-msdownload' }),
      'upload_content_type_not_allowed',
    );
  });

  it('the emitted upload route enforces validation SERVER-SIDE before storage', () => {
    const route = emitUploadRoute(SLOT);
    // Calls the structural validator and 400s on failure.
    expect(route).toContain('validateUpload(SLUG, { size: file.size, contentType: file.type })');
    expect(route).toContain('{ status: 400 }');
    // Pins owner_id server-side; never trusts the client.
    expect(route).toContain('owner_id: userId');
    // Owner-id path prefix into the private bucket.
    expect(route).toContain("userId + '/' + SLUG + '/'");
    expect(route).toContain("from(BUCKET)");
  });

  it('the emitted policy file carries the vetted per-slot limits + allowlist', () => {
    const file = emitUploadPolicyFile(uploadSpec());
    expect(file).toContain('"attachment": { maxSizeMb: 5, contentTypes: ["image/png","image/jpeg"] }');
    expect(file).toContain('upload_too_large');
    expect(file).toContain('upload_content_type_not_allowed');
  });
});

// ===========================================================================
// SIGNED-URL ACCESS (no public URL, short-lived)
// ===========================================================================
describe('downloads use server-generated short-lived signed URLs', () => {
  it('the download route signs a short-lived URL and never exposes a public one', () => {
    const route = emitSignedUrlRoute(SLOT);
    expect(route).toContain('createSignedUrl(');
    expect(route).toContain('SIGNED_URL_TTL_SECONDS = 60');
    // RLS-scoped lookup -> 404 when not owned.
    expect(route).toContain('{ status: 404 }');
    // NEVER a public URL, NEVER a long-lived link.
    expect(route).not.toContain('getPublicUrl');
    expect(route).not.toContain('publicUrl');
  });
});

// ===========================================================================
// PLANNER — gallery page via the page family
// ===========================================================================
describe('planner emits a gallery page per file-upload slot', () => {
  it('a gallery page_component task exists for the slot', () => {
    const g = deriveSoftwareGraph(uploadSpec());
    const page = g.tasks.find(
      (t) => t.slot.kind === 'page_component' && t.slot.target === 'attachment_files',
    );
    expect(page).toBeDefined();
    expect(page!.id).toBe('page_attachment_files');
  });

  it('BACKWARD COMPAT: a spec with no file_uploads emits no gallery page + no metadata table', () => {
    const spec = SoftwareSpecSchema.parse({
      goal: 'plain',
      pages: [{ id: 'home', name: 'Home', purpose: 'home' }],
      entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
      flows: [],
      auth: { requires_auth: true, per_user_isolation: true },
    });
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => String(t.slot.target).endsWith('_files'))).toBe(false);
    expect(entitiesToIsolate(spec)).toEqual(['note']);
  });
});

// ===========================================================================
// SPEC VALIDATION
// ===========================================================================
describe('file_uploads spec validation', () => {
  it('accepts a valid owner-scoped file_uploads list', () => {
    expect(() => uploadSpec()).not.toThrow();
  });

  it('rejects file_uploads when per_user_isolation is off', () => {
    expect(() =>
      uploadSpec({ auth: { requires_auth: true, per_user_isolation: false } }),
    ).toThrow();
  });

  it('rejects a file_upload name that collides with a declared entity', () => {
    expect(() =>
      uploadSpec({
        entities: [{ name: 'Attachment', fields: [{ name: 'x', type: 'string' }] }],
      }),
    ).toThrow();
  });

  it('rejects a gallery page id that collides with a declared page', () => {
    expect(() =>
      uploadSpec({
        pages: [{ id: 'attachment_files', name: 'X', purpose: 'collide' }],
      }),
    ).toThrow();
  });

  it('rejects an over-ceiling size limit', () => {
    expect(() =>
      uploadSpec({
        file_uploads: [{ name: 'Attachment', max_size_mb: 9999, content_types: ['image/png'] }],
      }),
    ).toThrow();
  });

  it('rejects an empty content-type allowlist', () => {
    expect(() =>
      uploadSpec({
        file_uploads: [{ name: 'Attachment', max_size_mb: 5, content_types: [] }],
      }),
    ).toThrow();
  });
});
