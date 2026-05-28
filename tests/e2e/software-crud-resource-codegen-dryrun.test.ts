// Hermetic — CRUD-resource generation via the EXISTING vetted families.
// Proves: the 5 owner-scoped routes generate via the ROUTE family and the
// resource page via the PAGE family (mocked LLM); the owner-scoped SCHEMA
// is structural and NEVER reaches the LLM (the migration is emitted
// deterministically regardless of what the model returns). Mirrors
// software-codegen-dryrun: scaffold + migration + static check run for
// real; only complete() is stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

import { complete } from '@/lib/engine/llm';
import { generateSoftwareCode } from '@/lib/engine/software/codegen/generate';
import { deriveSoftwareGraph } from '@/lib/engine/software/planner/graph';
import {
  ROUTE_SYSTEM_PROMPT,
  PAGE_SYSTEM_PROMPT,
} from '@/lib/engine/software/codegen/prompts';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '@/lib/engine/software/planner/schema';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;

function crudSpec(): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A personal notes app with per-user notes.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview of the user activity' }],
    entities: [
      {
        name: 'Note',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'body', type: 'text' },
          { name: 'done', type: 'boolean' },
        ],
      },
    ],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    crud_resources: ['Note'],
  });
}

// Build the plan deterministically from the graph (no LLM planner needed).
function crudPlan(spec: SoftwareSpec): SoftwareBuildPlan {
  const g = deriveSoftwareGraph(spec);
  return SoftwareBuildPlanSchema.parse({
    template_id: 'nextjs-supabase-app',
    tasks: g.tasks.map((t) => ({
      id: t.id,
      layer: t.layer,
      description: t.description,
      depends_on: t.depends_on,
      slot: t.slot,
      files: t.files,
    })),
    execution_order: g.executionOrder,
    warnings: [],
  });
}

const GOV = {
  user_id: 'u-crud',
  project_id: 'p-crud',
  ref: 'software.codegen.crud',
};

beforeEach(() => {
  completeMock.mockReset();
  // Any parseable body — we're testing slot routing + paths + schema
  // determinism, not the runtime correctness of the generated code.
  completeMock.mockResolvedValue({
    text: 'export const placeholder = 1;\n',
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('CRUD-resource codegen via the vetted families', () => {
  it('generates the 5 owner-scoped routes + the resource page; schema is structural (never reaches the LLM)', async () => {
    const spec = crudSpec();
    const plan = crudPlan(spec);

    const summary = await generateSoftwareCode({ spec, plan, governance: GOV });

    const paths = summary.files.map((f) => f.path);

    // --- 5 owner-scoped route slot files at the expected paths ---
    expect(paths).toContain('app/api/note/_create.ts');
    expect(paths).toContain('app/api/note/_list.ts');
    expect(paths).toContain('app/api/note/[id]/_get.ts');
    expect(paths).toContain('app/api/note/[id]/_update.ts');
    expect(paths).toContain('app/api/note/[id]/_delete.ts');
    // Shell route.ts files for the collection + item directories.
    expect(paths).toContain('app/api/note/route.ts');
    expect(paths).toContain('app/api/note/[id]/route.ts');

    // --- the resource page via the PAGE family ---
    expect(paths).toContain('app/(app)/note/page.tsx');

    // --- SCHEMA is structural — emitted deterministically, NOT by the LLM ---
    // No complete() call's prompt mentions the migration file: the schema
    // never reaches the model.
    const allUserMessages = completeMock.mock.calls
      .map((c) => (c[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '')
      .join('\n----\n');
    expect(allUserMessages).not.toContain('supabase/migrations');
    // The migration in the output IS owner-scoped (owner_id + RLS).
    const migration = summary.files.find(
      (f) => f.path === 'supabase/migrations/0001_init.sql',
    );
    expect(migration).toBeDefined();
    expect(migration!.content).toContain('owner_id uuid not null references auth.users(id)');
    expect(migration!.content).toContain('create policy note_owner on public.note');

    // --- the get-by-id route went through the ROUTE family ---
    const getRouteCall = completeMock.mock.calls.find(
      (c) =>
        (c[0] as { system: string }).system === ROUTE_SYSTEM_PROMPT &&
        ((c[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '').includes(
          'GET /api/note/[id]',
        ),
    );
    expect(getRouteCall).toBeDefined();

    // --- the create route pins owner_id server-side (route family criterion) ---
    const createRouteCall = completeMock.mock.calls.find(
      (c) =>
        (c[0] as { system: string }).system === ROUTE_SYSTEM_PROMPT &&
        ((c[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '').includes(
          'POST /api/note',
        ),
    );
    expect(createRouteCall).toBeDefined();
    expect(
      (createRouteCall![0] as { messages: Array<{ content: string }> }).messages[0]!.content,
    ).toContain('owner_id');

    // --- the resource page went through the PAGE family (server component) ---
    const pageCall = completeMock.mock.calls.find(
      (c) => (c[0] as { system: string }).system === PAGE_SYSTEM_PROMPT,
    );
    expect(pageCall).toBeDefined();
  });

  it('the migration is byte-identical regardless of what the LLM returns (schema is deterministic)', async () => {
    const spec = crudSpec();
    const plan = crudPlan(spec);

    completeMock.mockResolvedValue({
      text: 'export const a = 1;\n',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'mock',
    });
    const run1 = await generateSoftwareCode({ spec, plan, governance: GOV });

    completeMock.mockReset();
    completeMock.mockResolvedValue({
      text: 'export const totallyDifferent = 999;\n',
      usage: { input_tokens: 2, output_tokens: 2 },
      model: 'mock',
    });
    const run2 = await generateSoftwareCode({ spec, plan, governance: GOV });

    const mig1 = run1.files.find((f) => f.path === 'supabase/migrations/0001_init.sql')!.content;
    const mig2 = run2.files.find((f) => f.path === 'supabase/migrations/0001_init.sql')!.content;
    expect(mig1).toBe(mig2);
  });
});
