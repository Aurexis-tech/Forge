// Aurexis Forge — Phase 3 (Software) FILE-UPLOAD slot.
//
// Owner-scoped, private file storage. Files are isolated per user (A can
// NEVER read/download B's files), accessed via short-lived server-
// generated SIGNED URLs, with server-enforced size + content-type
// validation. This EXTENDS the per-user RLS isolation discipline from the
// database to Supabase Storage.
//
// WHAT IS STRUCTURAL (vetted, deterministic, NEVER reaches the LLM —
// byte-identical regardless of model output, same guarantee as the DB
// schema):
//   - the PRIVATE storage bucket (never public)
//   - the owner-scoped storage RLS policies, keyed on the owner-id path
//     prefix: (storage.foldername(name))[1] = auth.uid()::text
//   - the owner-scoped METADATA table (owner_id + RLS, via the schema slot)
//   - the server-side UPLOAD route (validates size + content-type, pins
//     owner_id, writes under {user_id}/<slug>/...)
//   - the SIGNED-URL download route (server-generated short-lived URL)
//   - the per-slot upload POLICY + validateUpload (size limit + content-
//     type allowlist)
//
// WHAT THE LLM FILLS: only the incidental gallery PAGE body (via the page
// family) — list the user's own files. The page never decides security.
//
// THE TEST BOUNDARY (be explicit):
//   - The metadata table's DB RLS isolation IS hermetically testable — it
//     lands in 0001_init.sql and the pglite cross-user isolation test
//     covers it (B can't read/update/delete A's metadata rows).
//   - The STORAGE-level isolation (B can't download A's actual files) is
//     NOT hermetically testable: pglite is DB-only and has no Supabase
//     Storage (storage.objects / storage.foldername). The storage policy
//     lands in a SEPARATE 0002_storage.sql that the pglite driver never
//     applies. Storage isolation is therefore proven STRUCTURALLY here
//     (the policy text is the vetted owner-scoped one) and the RUNTIME
//     proof is a DEFERRED real-Supabase-run validation item — a labelled
//     deferred check, NOT a silent gap.

import { badInputError } from '../../errors';
import type { SoftwareSpec } from '../spec';

// ONE private bucket per app; files are namespaced by an owner-id path
// prefix ({user_id}/<slug>/<file>) so a single owner-scoped policy
// isolates every slot's files.
export const STORAGE_BUCKET_ID = 'user_files';

// The separate migration that carries storage (bucket + policy). It is
// deliberately NOT 0001_init.sql: the pglite isolation driver applies only
// 0001, and pglite has no Supabase Storage schema, so keeping storage out
// of 0001 keeps the DB isolation test honest while the storage policy
// ships for the real Supabase run.
export const STORAGE_MIGRATION_PATH = 'supabase/migrations/0002_storage.sql';

export const UPLOAD_POLICY_PATH = 'lib/upload/policy.ts';

// ---------------------------------------------------------------------------
// Mechanical helpers (inlined — file-upload.ts must NOT import migration.ts;
// migration.ts imports THIS module for the metadata entities, so the
// dependency stays one-directional).
// ---------------------------------------------------------------------------
function slugify(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function kebab(slug: string): string {
  return slug.replace(/_/g, '-');
}

// ---------------------------------------------------------------------------
// Normalised slot view.
// ---------------------------------------------------------------------------
export interface FileUploadSlot {
  /** PascalCase metadata entity name (e.g. 'Attachment'). */
  readonly name: string;
  /** lower_snake_case table + path-segment slug (e.g. 'attachment'). */
  readonly slug: string;
  /** Server-enforced max size (MB). */
  readonly maxSizeMb: number;
  /** Server-enforced content-type allowlist (e.g. ['image/png']). */
  readonly contentTypes: ReadonlyArray<string>;
}

export interface UploadPolicy {
  readonly maxSizeMb: number;
  readonly contentTypes: ReadonlyArray<string>;
}

/** Normalised file-upload slots declared on a spec (empty when none). */
export function fileUploadSlots(spec: SoftwareSpec): FileUploadSlot[] {
  return (spec.file_uploads ?? []).map((u) => ({
    name: u.name,
    slug: slugify(u.name),
    maxSizeMb: u.max_size_mb,
    contentTypes: u.content_types,
  }));
}

// The fixed-shape metadata entity for a file-upload slot. The schema slot
// adds id + owner_id + created_at; these are the slot's own columns. Shape
// matches the brief: { path, filename, size, content_type }.
export interface SyntheticEntity {
  readonly name: string;
  readonly fields: ReadonlyArray<{ name: string; type: string }>;
}

/**
 * The synthetic metadata entities for a spec's file-upload slots. Fed into
 * the migration walk + the isolation table set so each metadata table gets
 * owner_id + RLS (structural) and is covered by the pglite DB isolation
 * test — exactly like a declared entity.
 */
export function fileUploadMetadataEntities(spec: SoftwareSpec): SyntheticEntity[] {
  return fileUploadSlots(spec).map((s) => ({
    name: s.name,
    fields: [
      { name: 'path', type: 'text' },
      { name: 'filename', type: 'string' },
      { name: 'size', type: 'number' },
      { name: 'content_type', type: 'string' },
    ],
  }));
}

export interface FileUploadPageDescriptor {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

/** Synthesized gallery page id for a slot (distinct from the table slug). */
export function fileUploadGalleryPageId(name: string): string {
  return slugify(name) + '_files';
}

/** Synthesized gallery page descriptors for a spec's file-upload slots. */
export function fileUploadGalleryPages(spec: SoftwareSpec): FileUploadPageDescriptor[] {
  return fileUploadSlots(spec).map((s) => ({
    id: fileUploadGalleryPageId(s.name),
    name: s.name + ' files',
    purpose:
      "List the signed-in user's own " +
      s.name +
      ' files (owner-scoped via the ' +
      s.slug +
      ' metadata table; downloads use short-lived server-generated signed URLs).',
  }));
}

// ===========================================================================
// PURE VALIDATION — server-enforced size + content-type. The generated
// upload route calls the EMITTED mirror of this (lib/upload/policy.ts);
// this engine copy is the canonical, unit-tested logic.
// ===========================================================================
export function validateUpload(
  policy: UploadPolicy,
  input: { size: number; contentType: string },
): void {
  const maxBytes = policy.maxSizeMb * 1024 * 1024;
  if (!Number.isFinite(input.size) || input.size < 0) {
    throw badInputError(
      'upload_invalid_size',
      'upload size is not a valid byte count: ' + String(input.size),
      'The uploaded file size is invalid.',
    );
  }
  if (input.size > maxBytes) {
    throw badInputError(
      'upload_too_large',
      'upload of ' +
        input.size +
        ' bytes exceeds the ' +
        policy.maxSizeMb +
        'MB limit',
      'That file is too large (limit ' + policy.maxSizeMb + 'MB).',
    );
  }
  if (!policy.contentTypes.includes(input.contentType)) {
    throw badInputError(
      'upload_content_type_not_allowed',
      "content-type '" +
        input.contentType +
        "' is not in the allowlist: " +
        policy.contentTypes.join(', '),
      'That file type is not allowed.',
    );
  }
}

// ===========================================================================
// STRUCTURAL EMITTERS — all byte-identical from the slot config; the LLM
// never sees or authors any of these.
// ===========================================================================

/**
 * The storage migration (0002_storage.sql): a PRIVATE bucket + the vetted
 * owner-scoped RLS policies on storage.objects. Returns '' when the spec
 * declares no file uploads (so nothing is emitted / the migration is
 * byte-identical to a no-upload app). NEVER takes LLM input.
 */
export function emitStorageMigration(spec: SoftwareSpec): string {
  const slots = fileUploadSlots(spec);
  if (slots.length === 0) return '';

  const b = STORAGE_BUCKET_ID;
  const lines: string[] = [];
  lines.push('-- Aurexis Forge — generated storage migration (template-emitted, NOT LLM-authored).');
  lines.push('-- A PRIVATE bucket + owner-scoped RLS on storage.objects. Files live under');
  lines.push("-- a path prefixed by the owner's id ({user_id}/<slug>/<file>); the policy");
  lines.push('-- scopes every operation to (storage.foldername(name))[1] = auth.uid()::text.');
  lines.push('--');
  lines.push('-- NOTE: storage-level isolation is NOT covered by the hermetic pglite');
  lines.push('-- isolation test (pglite is DB-only, no Supabase Storage). It is proven');
  lines.push('-- structurally by THIS vetted policy text; the runtime proof is a deferred');
  lines.push('-- real-Supabase-run validation item.');
  lines.push('');
  // Private bucket — public = false, ALWAYS.
  lines.push(
    "insert into storage.buckets (id, name, public) values ('" +
      b +
      "', '" +
      b +
      "', false) on conflict (id) do nothing;",
  );
  lines.push('');
  // Owner-scoped policies — one per operation. The owner-id path prefix is
  // the first folder segment of the object name.
  const ownerExpr = "(storage.foldername(name))[1] = auth.uid()::text";
  const bucketExpr = "bucket_id = '" + b + "'";
  lines.push("drop policy if exists " + b + "_select on storage.objects;");
  lines.push(
    'create policy ' +
      b +
      '_select on storage.objects for select to authenticated using (' +
      bucketExpr +
      ' and ' +
      ownerExpr +
      ');',
  );
  lines.push("drop policy if exists " + b + "_insert on storage.objects;");
  lines.push(
    'create policy ' +
      b +
      '_insert on storage.objects for insert to authenticated with check (' +
      bucketExpr +
      ' and ' +
      ownerExpr +
      ');',
  );
  lines.push("drop policy if exists " + b + "_update on storage.objects;");
  lines.push(
    'create policy ' +
      b +
      '_update on storage.objects for update to authenticated using (' +
      bucketExpr +
      ' and ' +
      ownerExpr +
      ') with check (' +
      bucketExpr +
      ' and ' +
      ownerExpr +
      ');',
  );
  lines.push("drop policy if exists " + b + "_delete on storage.objects;");
  lines.push(
    'create policy ' +
      b +
      '_delete on storage.objects for delete to authenticated using (' +
      bucketExpr +
      ' and ' +
      ownerExpr +
      ');',
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * lib/upload/policy.ts — the per-slot upload policy map + a validateUpload
 * mirror the server-side upload route calls. Structural; the limits come
 * from the slot config, never the LLM.
 */
export function emitUploadPolicyFile(spec: SoftwareSpec): string {
  const slots = fileUploadSlots(spec);
  const entries = slots
    .map(
      (s) =>
        '  ' +
        JSON.stringify(s.slug) +
        ': { maxSizeMb: ' +
        s.maxSizeMb +
        ', contentTypes: ' +
        JSON.stringify(s.contentTypes) +
        ' },',
    )
    .join('\n');
  return [
    '// Aurexis Forge — upload policy (template-emitted, NOT LLM-authored).',
    '//',
    '// Server-enforced size limit + content-type allowlist per upload slot.',
    '// The upload route calls validateUpload() BEFORE touching storage; the',
    '// limits here are the vetted slot config, not a client hint.',
    '',
    'export interface UploadPolicy {',
    '  readonly maxSizeMb: number;',
    '  readonly contentTypes: readonly string[];',
    '}',
    '',
    'export const UPLOAD_POLICIES: Record<string, UploadPolicy> = {',
    entries,
    '};',
    '',
    'export interface UploadValidationError {',
    '  readonly code: string;',
    '  readonly message: string;',
    '}',
    '',
    '// Returns null when valid, or a typed error to surface as HTTP 400.',
    'export function validateUpload(',
    '  slug: string,',
    '  input: { size: number; contentType: string },',
    '): UploadValidationError | null {',
    '  const policy = UPLOAD_POLICIES[slug];',
    '  if (!policy) {',
    "    return { code: 'upload_unknown_slot', message: 'unknown upload slot: ' + slug };",
    '  }',
    '  const maxBytes = policy.maxSizeMb * 1024 * 1024;',
    '  if (!Number.isFinite(input.size) || input.size < 0) {',
    "    return { code: 'upload_invalid_size', message: 'invalid file size' };",
    '  }',
    '  if (input.size > maxBytes) {',
    "    return { code: 'upload_too_large', message: 'file exceeds the ' + policy.maxSizeMb + 'MB limit' };",
    '  }',
    '  if (!policy.contentTypes.includes(input.contentType)) {',
    "    return { code: 'upload_content_type_not_allowed', message: 'content-type ' + input.contentType + ' is not allowed' };",
    '  }',
    '  return null;',
    '}',
    '',
  ].join('\n');
}

export function uploadRoutePath(slug: string): string {
  return 'app/api/uploads/' + slug + '/route.ts';
}

export function signedUrlRoutePath(slug: string): string {
  return 'app/api/uploads/' + slug + '/[id]/route.ts';
}

/**
 * The server-side UPLOAD route (POST). Validates size + content-type
 * server-side, pins owner_id, writes the object under {user_id}/<slug>/...
 * in the PRIVATE bucket, then records owner-scoped metadata. Structural —
 * the LLM never authors this.
 */
export function emitUploadRoute(slot: FileUploadSlot): string {
  const table = slot.slug;
  return [
    '// Aurexis Forge — file upload route (template-emitted, NOT LLM-authored).',
    '//',
    '// POST a multipart form with a `file` field. The handler validates the',
    '// size + content-type SERVER-SIDE against the vetted policy, pins',
    '// owner_id to the authenticated user, stores the object under an',
    "// owner-id-prefixed path in the PRIVATE '" + STORAGE_BUCKET_ID + "' bucket,",
    '// then records owner-scoped metadata. RLS isolates both the object and',
    '// the metadata row to the owner.',
    "import { createServerClient } from '@/lib/supabase/server';",
    "import { currentUserId } from '@/lib/auth/roles';",
    "import { validateUpload } from '@/lib/upload/policy';",
    '',
    "const BUCKET = '" + STORAGE_BUCKET_ID + "';",
    "const SLUG = '" + slot.slug + "';",
    '',
    'export async function POST(request: Request): Promise<Response> {',
    '  const userId = await currentUserId();',
    '  if (!userId) {',
    "    return Response.json({ error: 'unauthenticated' }, { status: 401 });",
    '  }',
    '',
    '  let form: FormData;',
    '  try {',
    '    form = await request.formData();',
    '  } catch {',
    "    return Response.json({ error: 'expected multipart/form-data' }, { status: 400 });",
    '  }',
    "  const file = form.get('file');",
    '  if (!(file instanceof File)) {',
    "    return Response.json({ error: 'missing file field' }, { status: 400 });",
    '  }',
    '',
    '  // SERVER-ENFORCED validation — size + content-type, before storage.',
    '  const invalid = validateUpload(SLUG, { size: file.size, contentType: file.type });',
    '  if (invalid) {',
    '    return Response.json({ error: invalid.message, code: invalid.code }, { status: 400 });',
    '  }',
    '',
    '  const supabase = createServerClient();',
    '  // Owner-id path prefix — the storage RLS policy scopes access to',
    '  // (storage.foldername(name))[1] = auth.uid()::text.',
    '  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, \'_\');',
    '  const path = userId + \'/\' + SLUG + \'/\' + crypto.randomUUID() + \'-\' + safeName;',
    '  const { error: uploadError } = await supabase.storage',
    '    .from(BUCKET)',
    '    .upload(path, file, { contentType: file.type, upsert: false });',
    '  if (uploadError) {',
    "    return Response.json({ error: 'upload failed: ' + uploadError.message }, { status: 500 });",
    '  }',
    '',
    '  const { data, error } = await supabase',
    "    .from('" + table + "')",
    '    .insert({',
    '      owner_id: userId,  // pinned server-side — never from the client',
    '      path,',
    '      filename: file.name,',
    '      size: file.size,',
    '      content_type: file.type,',
    '    })',
    "    .select('id, path, filename, size, content_type, created_at')",
    '    .single();',
    '  if (error) {',
    '    // Roll back the orphaned object so storage + metadata stay consistent.',
    '    await supabase.storage.from(BUCKET).remove([path]);',
    "    return Response.json({ error: 'metadata insert failed: ' + error.message }, { status: 500 });",
    '  }',
    '  return Response.json(data, { status: 201 });',
    '}',
    '',
  ].join('\n');
}

/**
 * The signed-URL download route (GET). Looks up the metadata row by id
 * (RLS-scoped to the owner), then returns a SHORT-LIVED server-generated
 * signed URL — never a public URL, never a long-lived link. Structural.
 */
export function emitSignedUrlRoute(slot: FileUploadSlot): string {
  const table = slot.slug;
  return [
    '// Aurexis Forge — signed-URL download route (template-emitted, NOT LLM-authored).',
    '//',
    '// GET returns a SHORT-LIVED (60s) server-generated signed URL for the',
    "// caller's OWN file. The metadata lookup is RLS-scoped (404 when the row",
    '// is absent or not owned); the bucket is private, so there is no public',
    '// URL and no long-lived link.',
    "import { createServerClient } from '@/lib/supabase/server';",
    "import { currentUserId } from '@/lib/auth/roles';",
    '',
    "const BUCKET = '" + STORAGE_BUCKET_ID + "';",
    '// Short-lived: the signed URL expires in 60 seconds.',
    'const SIGNED_URL_TTL_SECONDS = 60;',
    '',
    'export async function GET(',
    '  _request: Request,',
    '  context: { params: { id: string } },',
    '): Promise<Response> {',
    '  const userId = await currentUserId();',
    '  if (!userId) {',
    "    return Response.json({ error: 'unauthenticated' }, { status: 401 });",
    '  }',
    '  const id = context.params.id;',
    '  if (!id) {',
    "    return Response.json({ error: 'missing id' }, { status: 400 });",
    '  }',
    '',
    '  const supabase = createServerClient();',
    '  const { data: row, error } = await supabase',
    "    .from('" + table + "')",
    "    .select('id, path')",
    "    .eq('id', id)",
    '    .maybeSingle();  // RLS scopes this to the owner',
    '  if (error) {',
    "    return Response.json({ error: 'lookup failed: ' + error.message }, { status: 500 });",
    '  }',
    '  if (!row) {',
    "    return Response.json({ error: 'not found' }, { status: 404 });",
    '  }',
    '',
    '  const { data: signed, error: signError } = await supabase.storage',
    '    .from(BUCKET)',
    '    .createSignedUrl(row.path as string, SIGNED_URL_TTL_SECONDS);',
    '  if (signError || !signed) {',
    "    return Response.json({ error: 'could not sign url' }, { status: 500 });",
    '  }',
    '  return Response.json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS }, { status: 200 });',
    '}',
    '',
  ].join('\n');
}

// ===========================================================================
// COMPOSITE EXPANSION — the deterministic atomic-slot descriptor set. PURE,
// no IO. Same slot -> same expansion. Used by tests + documentation; the
// owner-scoping/validation/signed-url come from the structural emitters
// above, NOT the LLM.
// ===========================================================================
export interface FileUploadAtomicSlot {
  readonly kind:
    | 'storage_bucket'
    | 'storage_policy'
    | 'metadata_table'
    | 'upload_policy'
    | 'upload_route'
    | 'signed_url_route'
    | 'gallery_page';
  readonly structural: boolean; // true = never reaches the LLM
  readonly path: string;
  readonly target: string; // slot name / table / page id
}

export interface FileUploadExpansion {
  readonly slot: FileUploadSlot;
  readonly bucket: { id: string; public: boolean };
  readonly slots: ReadonlyArray<FileUploadAtomicSlot>;
  readonly galleryPage: FileUploadPageDescriptor;
}

export function expandFileUpload(slot: FileUploadSlot): FileUploadExpansion {
  const galleryPage: FileUploadPageDescriptor = {
    id: fileUploadGalleryPageId(slot.name),
    name: slot.name + ' files',
    purpose:
      "List the signed-in user's own " + slot.name + ' files (owner-scoped).',
  };
  const atomic: FileUploadAtomicSlot[] = [
    { kind: 'storage_bucket', structural: true, path: STORAGE_MIGRATION_PATH, target: STORAGE_BUCKET_ID },
    { kind: 'storage_policy', structural: true, path: STORAGE_MIGRATION_PATH, target: STORAGE_BUCKET_ID },
    { kind: 'metadata_table', structural: true, path: 'supabase/migrations/0001_init.sql', target: slot.name },
    { kind: 'upload_policy', structural: true, path: UPLOAD_POLICY_PATH, target: slot.slug },
    { kind: 'upload_route', structural: true, path: uploadRoutePath(slot.slug), target: slot.slug },
    { kind: 'signed_url_route', structural: true, path: signedUrlRoutePath(slot.slug), target: slot.slug },
    // The ONLY LLM-filled artefact: the gallery page (incidental content).
    { kind: 'gallery_page', structural: false, path: 'app/(app)/' + kebab(galleryPage.id) + '/page.tsx', target: galleryPage.id },
  ];
  return {
    slot,
    bucket: { id: STORAGE_BUCKET_ID, public: false },
    slots: atomic,
    galleryPage,
  };
}
