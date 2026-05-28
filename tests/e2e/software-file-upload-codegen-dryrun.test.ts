// Hermetic — file-upload generation. Proves the security-critical files
// (private bucket + owner-scoped storage policy, server-side upload route,
// signed-URL route, validation policy) are STRUCTURAL — emitted
// deterministically and NEVER reaching the LLM — while only the gallery
// page goes through the page family. Mirrors the software codegen dry-run:
// scaffold + migration + static check run for real; only complete() is
// stubbed.

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

function uploadSpec(): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A notes app with image attachments.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    file_uploads: [
      { name: 'Attachment', max_size_mb: 5, content_types: ['image/png', 'image/jpeg'] },
    ],
  });
}

function uploadPlan(spec: SoftwareSpec): SoftwareBuildPlan {
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

const GOV = { user_id: 'u-fu', project_id: 'p-fu', ref: 'software.codegen.fu' };

beforeEach(() => {
  completeMock.mockReset();
  completeMock.mockResolvedValue({
    text: 'export const placeholder = 1;\n',
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('file-upload codegen — structural storage, LLM only for the gallery page', () => {
  it('emits the structural files; the storage policy NEVER reaches the LLM', async () => {
    const spec = uploadSpec();
    const plan = uploadPlan(spec);
    const summary = await generateSoftwareCode({ spec, plan, governance: GOV });
    const byPath = new Map(summary.files.map((f) => [f.path, f.content]));

    // --- the structural file-upload files exist ---
    expect(byPath.has('supabase/migrations/0002_storage.sql')).toBe(true);
    expect(byPath.has('lib/upload/policy.ts')).toBe(true);
    expect(byPath.has('app/api/uploads/attachment/route.ts')).toBe(true);
    expect(byPath.has('app/api/uploads/attachment/[id]/route.ts')).toBe(true);
    // --- the gallery page (LLM-filled via the page family) ---
    expect(byPath.has('app/(app)/attachment-files/page.tsx')).toBe(true);

    // --- the storage policy is the vetted owner-scoped one, private bucket ---
    const storage = byPath.get('supabase/migrations/0002_storage.sql')!;
    expect(storage).toContain("(storage.foldername(name))[1] = auth.uid()::text");
    expect(storage).toContain("'user_files', 'user_files', false");

    // --- the metadata table (0001) is owner-scoped ---
    const migration = byPath.get('supabase/migrations/0001_init.sql')!;
    expect(migration).toContain('create policy attachment_owner on public.attachment');
    expect(migration).toContain('owner_id uuid not null references auth.users(id)');

    // --- the storage policy / bucket / upload route NEVER appear in any LLM prompt ---
    const allUserMessages = completeMock.mock.calls
      .map((c) => (c[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '')
      .join('\n----\n');
    expect(allUserMessages).not.toContain('storage.foldername');
    expect(allUserMessages).not.toContain('storage.objects');
    expect(allUserMessages).not.toContain('0002_storage');
    expect(allUserMessages).not.toContain('createSignedUrl');

    // --- the gallery page DID go through the PAGE family ---
    const pageCall = completeMock.mock.calls.find(
      (c) => (c[0] as { system: string }).system === PAGE_SYSTEM_PROMPT_CACHED,
    );
    expect(pageCall).toBeDefined();
  });

  it('the structural files are byte-identical regardless of what the LLM returns', async () => {
    const spec = uploadSpec();
    const plan = uploadPlan(spec);

    completeMock.mockResolvedValue({
      text: 'export const a = 1;\n',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'mock',
    });
    const run1 = await generateSoftwareCode({ spec, plan, governance: GOV });

    completeMock.mockReset();
    completeMock.mockResolvedValue({
      text: 'export const wildlyDifferent = 42;\n',
      usage: { input_tokens: 2, output_tokens: 2 },
      model: 'mock',
    });
    const run2 = await generateSoftwareCode({ spec, plan, governance: GOV });

    const pick = (summary: typeof run1, path: string) =>
      summary.files.find((f) => f.path === path)!.content;

    for (const path of [
      'supabase/migrations/0002_storage.sql',
      'lib/upload/policy.ts',
      'app/api/uploads/attachment/route.ts',
      'app/api/uploads/attachment/[id]/route.ts',
    ]) {
      expect(pick(run1, path)).toBe(pick(run2, path));
    }
  });
});
