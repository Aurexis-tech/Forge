// Aurexis Forge — Phase 3 (Software) spec schema.
//
// A SoftwareSpec describes a small web app: pages the user sees,
// entities the app stores, flows that connect them, and the auth
// model that gates them. This is the THIRD mold on the existing
// engine — Phase 1's AgentSpec and Phase 2's SystemSpec continue to
// work unchanged. The engine picks the schema based on the `kind`
// discriminator persisted on the `specs` row (extended in
// supabase/migrations/0014_software.sql to include 'software').
//
// Phase 3 is INTAKE-ONLY in this prompt: schema, classifier extension,
// extractor, persistence, review gate. Generation, sandbox, deploy,
// runtime are NOT extended yet — confirmed software specs stop at
// the gate, and the planner loaders both refuse them server-side
// (defence in depth for direct API callers).

import { z } from 'zod';

// IDs reuse the lower_snake_case convention shared with AgentSpec
// capability tools + SystemSpec sub_agent ids. Pages and flows
// reference each other by these stable identifiers.
const ID_RE = /^[a-z][a-z0-9_]*$/;
const PageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(ID_RE, 'page id must be lower_snake_case starting with a letter');

const EntityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Z][A-Za-z0-9]*$/, 'entity name must be PascalCase');

const FieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(ID_RE, 'field name must be lower_snake_case starting with a letter');

// The narrow set of field types the codegen layer can wire later
// without an open-ended type system. 'reference' is a relationship to
// another entity declared in the same spec (the planner will validate
// the target name once it lands; here we just accept it as a typed
// string).
export const FIELD_TYPES = [
  'string',
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'email',
  'url',
  'enum',
  'reference',
] as const;

const FieldSchema = z.object({
  name: FieldNameSchema,
  type: z.enum(FIELD_TYPES),
});

// Hard ceiling on a file-upload slot's configurable size limit. The engine
// owns the cap so a bad spec can't allow a pathologically large upload.
export const MAX_UPLOAD_SIZE_MB_CEILING = 100;

// One file-upload slot: a private, owner-scoped storage resource. `name`
// is the PascalCase metadata entity (e.g. 'Attachment'); the size limit +
// content-type allowlist are SERVER-ENFORCED (validated server-side, not a
// client hint). Owner-scoping + the storage policy are structural (vetted
// templates) — see lib/engine/software/codegen/file-upload.ts.
const FileUploadSchema = z.object({
  name: EntityNameSchema,
  max_size_mb: z.number().int().min(1).max(MAX_UPLOAD_SIZE_MB_CEILING),
  // MIME types, e.g. 'image/png'. Non-empty allowlist — a slot must
  // declare what it accepts; nothing is accepted by default.
  content_types: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+*-]*$/i, 'content_type must be a MIME type like image/png'),
    )
    .min(1)
    .max(40),
});

// PascalCase entity name -> lower_snake_case table/page slug. Mirrors
// migration.tableName() / crud-resource.crudResourcePageId(); inlined here
// to keep the spec module dependency-free (spec.ts is the leaf the codegen
// modules import, so it must not import them back).
function entitySlug(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

const PageSchema = z.object({
  id: PageIdSchema,
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(400),
});

const EntitySchema = z.object({
  name: EntityNameSchema,
  fields: z.array(FieldSchema).min(1).max(40),
});

const FlowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  // Pages the flow walks through. Optional — some flows are pure
  // background (e.g. cron-like reminders), but most surface UI.
  pages: z.array(PageIdSchema).max(20).optional(),
});

const AuthSchema = z.object({
  requires_auth: z.boolean(),
  // Free-form role labels. The planner will resolve these to actual
  // RBAC implementation later; here we just record the user's intent.
  roles: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  // Whether each authenticated user only sees their own data
  // (Supabase RLS-style per-user isolation). Critical for the
  // downstream planner to pick the right scaffold.
  per_user_isolation: z.boolean(),
});

export const SoftwareSpecSchema = z
  .object({
    goal: z.string().trim().min(1).max(800),
    pages: z.array(PageSchema).min(1).max(20),
    entities: z.array(EntitySchema).min(1).max(20),
    flows: z.array(FlowSchema).max(20).default([]),
    auth: AuthSchema,
    // Optional third-party integrations the app needs (e.g. "stripe",
    // "sendgrid"). Recorded for the planner; not validated against a
    // registry yet — that lands when Phase 3 codegen comes online.
    integrations: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
    // OPTIONAL: entity names to expand via the CRUD-resource COMPOSITE
    // slot — complete owner-scoped CRUD (owner-scoped table + 5 routes
    // [create/list/get/update/delete] + a list/detail page) generated
    // DETERMINISTICALLY from the vetted atomic slots. Absent → no
    // CRUD-resource (existing per-entity derivation, byte-identical).
    // Each name must be a declared entity (validated below).
    crud_resources: z.array(EntityNameSchema).max(20).optional(),
    // OPTIONAL: an admin dashboard — the ONE slot that deliberately crosses
    // owner-scoping (an admin reads rows that aren't theirs). `entities` are
    // declared entities the admin may READ across owners. Owner-scoping for
    // everyone else is UNTOUCHED: the admin access is an ADDITIVE read-only
    // RLS policy + a server-side guard, both keyed on server-controlled JWT
    // app_metadata (a user cannot self-promote). Absent → no admin
    // dashboard (byte-identical). Requires per_user_isolation (validated
    // below — the admin policy is additive on top of the owner policy).
    admin_dashboard: z
      .object({ entities: z.array(EntityNameSchema).min(1).max(20) })
      .optional(),
    // OPTIONAL: file-upload slots — owner-scoped private file storage
    // (private bucket + vetted owner-scoped storage RLS policy + owner-
    // scoped metadata table + validated upload + signed-URL download +
    // gallery page). Each `name` synthesizes a metadata table + a gallery
    // page; storage owner-scoping is STRUCTURAL. Absent → no storage
    // (byte-identical). Requires per_user_isolation (validated below).
    file_uploads: z.array(FileUploadSchema).max(10).optional(),
  })
  .superRefine((data, ctx) => {
    // Unique page ids.
    const pageIds = new Set<string>();
    data.pages.forEach((p, i) => {
      if (pageIds.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', i, 'id'],
          message: "duplicate page id '" + p.id + "'",
        });
      }
      pageIds.add(p.id);
    });

    // Unique entity names.
    const entityNames = new Set<string>();
    data.entities.forEach((e, i) => {
      if (entityNames.has(e.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entities', i, 'name'],
          message: "duplicate entity name '" + e.name + "'",
        });
      }
      entityNames.add(e.name);
    });

    // Flow.pages references must point at real page ids.
    data.flows.forEach((f, fi) => {
      if (!f.pages) return;
      f.pages.forEach((pid, pi) => {
        if (!pageIds.has(pid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['flows', fi, 'pages', pi],
            message:
              "flow '" + f.name + "' references unknown page id '" + pid + "'",
          });
        }
      });
    });

    // crud_resources (opt-in CRUD-resource composite): each must be a
    // real entity; CRUD-resources are OWNER-SCOPED, so they require auth
    // + per-user isolation (the structural owner_id + RLS that the
    // composite relies on); and each resource's synthesized list-page id
    // must not collide with a declared page id.
    const crud = data.crud_resources ?? [];
    if (crud.length > 0) {
      if (!data.auth.requires_auth || !data.auth.per_user_isolation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['crud_resources'],
          message:
            'crud_resources are owner-scoped and require auth.requires_auth + auth.per_user_isolation',
        });
      }
      crud.forEach((name, i) => {
        if (!entityNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['crud_resources', i],
            message: "crud_resources references unknown entity '" + name + "'",
          });
        }
        const synthesizedPageId = entitySlug(name);
        if (pageIds.has(synthesizedPageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['crud_resources', i],
            message:
              "crud_resources entity '" +
              name +
              "' generates a list-page id '" +
              synthesizedPageId +
              "' that collides with a declared page id",
          });
        }
      });
    }

    // file_uploads (opt-in file-upload slot): owner-scoped private storage,
    // so they REQUIRE auth + per-user isolation. Each name synthesizes a
    // metadata table + a gallery page; reject collisions with declared
    // entities (the metadata table would clash), other uploads, or
    // declared pages (the gallery page would clash).
    const uploads = data.file_uploads ?? [];
    if (uploads.length > 0) {
      if (!data.auth.requires_auth || !data.auth.per_user_isolation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['file_uploads'],
          message:
            'file_uploads are owner-scoped and require auth.requires_auth + auth.per_user_isolation',
        });
      }
      const entitySlugs = new Set(data.entities.map((e) => entitySlug(e.name)));
      const seenUpload = new Set<string>();
      uploads.forEach((u, i) => {
        const slug = entitySlug(u.name);
        if (entityNames.has(u.name) || entitySlugs.has(slug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['file_uploads', i, 'name'],
            message:
              "file_uploads name '" +
              u.name +
              "' collides with a declared entity — the metadata table would clash",
          });
        }
        if (seenUpload.has(slug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['file_uploads', i, 'name'],
            message: "duplicate file_uploads name '" + u.name + "'",
          });
        }
        seenUpload.add(slug);
        const galleryPageId = slug + '_files';
        if (pageIds.has(galleryPageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['file_uploads', i, 'name'],
            message:
              "file_uploads name '" +
              u.name +
              "' generates a gallery page id '" +
              galleryPageId +
              "' that collides with a declared page id",
          });
        }
      });
    }

    // admin_dashboard (opt-in): the admin-read RLS policy is ADDITIVE on the
    // owner policy, so it REQUIRES auth + per-user isolation (otherwise there
    // is no owner-scoping to cross). Each viewable entity must be declared,
    // and the synthesized 'admin' page id must not collide with a declared
    // page. (The page id literal mirrors ADMIN_DASHBOARD_PAGE_ID in
    // admin-dashboard.ts; inlined here to keep spec the dependency leaf.)
    if (data.admin_dashboard) {
      if (!data.auth.requires_auth || !data.auth.per_user_isolation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['admin_dashboard'],
          message:
            'admin_dashboard crosses owner-scoping and requires auth.requires_auth + auth.per_user_isolation (the admin-read policy is additive on the owner policy)',
        });
      }
      data.admin_dashboard.entities.forEach((name, i) => {
        if (!entityNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['admin_dashboard', 'entities', i],
            message:
              "admin_dashboard.entities references unknown entity '" + name + "'",
          });
        }
      });
      if (pageIds.has('admin')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['admin_dashboard'],
          message:
            "admin_dashboard generates an 'admin' page id that collides with a declared page id",
        });
      }
    }
  });

export type SoftwareSpec = z.infer<typeof SoftwareSpecSchema>;

// Mirrors the AgentSpec / SystemSpec extraction result shape so the
// pending → needs_clarification → awaiting_review → confirmed state
// machine applies uniformly across all three kinds.
export const SoftwareExtractionResultSchema = z.object({
  spec: SoftwareSpecSchema,
  open_questions: z
    .array(z.string().trim().min(1).max(400))
    .max(3)
    .default([]),
});
export type SoftwareExtractionResult = z.infer<typeof SoftwareExtractionResultSchema>;
