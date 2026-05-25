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
