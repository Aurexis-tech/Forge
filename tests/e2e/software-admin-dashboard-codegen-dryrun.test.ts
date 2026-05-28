// Hermetic — admin-dashboard generation. Proves the two structural barriers
// (RLS admin-read policy in the migration + the server-side guard/layout)
// are emitted deterministically and NEVER reach the LLM, while only the
// admin VIEW page goes through the page family. Mirrors the software codegen
// dry-run: scaffold + migration + static check run for real; only complete()
// is stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

import { complete } from '@/lib/engine/llm';
import { generateSoftwareCode } from '@/lib/engine/software/codegen/generate';
import { deriveSoftwareGraph } from '@/lib/engine/software/planner/graph';
import { PAGE_SYSTEM_PROMPT_CACHED } from '@/lib/engine/software/codegen/prompts';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '@/lib/engine/software/planner/schema';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;

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

function adminPlan(spec: SoftwareSpec): SoftwareBuildPlan {
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

const GOV = { user_id: 'u-ad', project_id: 'p-ad', ref: 'software.codegen.ad' };

beforeEach(() => {
  completeMock.mockReset();
  completeMock.mockResolvedValue({
    text: 'export const placeholder = 1;\n',
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('admin-dashboard codegen — structural barriers, LLM only for the view', () => {
  it('emits the guard + layout + admin-read policy; none of it reaches the LLM', async () => {
    const spec = adminSpec();
    const plan = adminPlan(spec);
    const summary = await generateSoftwareCode({ spec, plan, governance: GOV });
    const byPath = new Map(summary.files.map((f) => [f.path, f.content]));

    // --- BARRIER 2 structural files ---
    expect(byPath.has('lib/auth/admin.ts')).toBe(true);
    expect(byPath.has('app/(app)/admin/layout.tsx')).toBe(true);
    // --- the admin VIEW page (LLM-filled via the page family) ---
    expect(byPath.has('app/(app)/admin/page.tsx')).toBe(true);

    // --- BARRIER 1: the admin-read policy is in the migration, app_metadata-keyed ---
    const migration = byPath.get('supabase/migrations/0001_init.sql')!;
    expect(migration).toContain('note_admin_read on public.note for select using');
    expect(migration).toContain("auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'");
    // owner policy untouched.
    expect(migration).toContain('create policy note_owner on public.note for all');

    // --- the guard reads app_metadata + redirects ---
    const guard = byPath.get('lib/auth/admin.ts')!;
    expect(guard).toContain("userHasAnyRole(['admin'])");

    // --- the policy / guard / metadata source NEVER appear in any LLM prompt ---
    const allUserMessages = completeMock.mock.calls
      .map((c) => (c[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '')
      .join('\n----\n');
    expect(allUserMessages).not.toContain('app_metadata');
    expect(allUserMessages).not.toContain('admin_read');
    expect(allUserMessages).not.toContain('requireAdmin');
    expect(allUserMessages).not.toContain('auth.jwt()');

    // --- the admin view page DID go through the PAGE family ---
    const pageCall = completeMock.mock.calls.find(
      (c) => (c[0] as { system: string }).system === PAGE_SYSTEM_PROMPT_CACHED,
    );
    expect(pageCall).toBeDefined();
  });

  it('the structural barriers are byte-identical regardless of LLM output', async () => {
    const spec = adminSpec();
    const plan = adminPlan(spec);

    completeMock.mockResolvedValue({ text: 'export const a = 1;\n', usage: { input_tokens: 1, output_tokens: 1 }, model: 'mock' });
    const run1 = await generateSoftwareCode({ spec, plan, governance: GOV });
    completeMock.mockReset();
    completeMock.mockResolvedValue({ text: 'export const z = 9;\n', usage: { input_tokens: 2, output_tokens: 2 }, model: 'mock' });
    const run2 = await generateSoftwareCode({ spec, plan, governance: GOV });

    const pick = (s: typeof run1, p: string) => s.files.find((f) => f.path === p)!.content;
    for (const p of ['supabase/migrations/0001_init.sql', 'lib/auth/admin.ts', 'app/(app)/admin/layout.tsx']) {
      expect(pick(run1, p)).toBe(pick(run2, p));
    }
  });
});
