// EQUIVALENCE / BEHAVIOR-PRESERVATION — the crux of the tool-contract
// migration.
//
// Before migrating the 8 planner tools + scaffold into the engine
// tool contract, we captured an immutable baseline of the shipped
// scaffold + the planner registry into tests/fixtures/scaffold-
// baseline.json. After the migration, the DERIVED values MUST match
// that baseline exactly for the 8 existing tools:
//
//   1. Shipped scaffold source for the 8 tools — BYTE-IDENTICAL.
//   2. The src/lib/tools/index.ts barrel + tsconfig/package/README/
//      types/runtime boilerplate — BYTE-IDENTICAL.
//   3. SCAFFOLD_TOOL_INTERFACE — BYTE-IDENTICAL.
//   4. TOOL_REGISTRY entries for the 8 tools — FIELD-IDENTICAL.
//   5. The codegen TOOLS section for the 8 tools — RENDER-IDENTICAL
//      (assembled via the same renderTool path the prompt uses).
//
// A divergence here is a MIGRATION BUG to fix, not a snapshot to
// update.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCAFFOLD_FILES,
  SCAFFOLD_TOOL_INTERFACE,
} from '@/lib/engine/codegen/scaffold/agent-node-tool-using';
import { TOOL_REGISTRY } from '@/lib/engine/planner/registry';
import {
  buildCodegenUserMessage,
} from '@/lib/engine/codegen/prompts';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';

interface Baseline {
  scaffoldFiles: Array<{ path: string; content: string }>;
  scaffoldToolInterface: string;
  toolRegistry: Array<{
    id: string;
    label: string;
    description: string;
    env_keys: string[];
    status: string;
  }>;
}

const baseline: Baseline = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'scaffold-baseline.json'),
    'utf8',
  ),
);

const LEGACY_TOOL_NAMES = [
  'web_search',
  'http_request',
  'llm_completion',
  'file_read',
  'file_write',
  'schedule',
  'email_read',
  'email_send',
];

// web_search was DELIBERATELY upgraded to a provider-backed (Brave)
// tool in the provider-tool prompt. Its scaffoldSource + interface line
// change on purpose; the OTHER 7 legacy tools stay byte-identical to
// the frozen pre-migration baseline.
const PROVIDER_UPGRADED = 'web_search';
const OTHER_LEGACY = LEGACY_TOOL_NAMES.filter((n) => n !== PROVIDER_UPGRADED);
// Scaffold SOURCE bodies that changed on purpose: web_search (Brave
// provider upgrade) and email_send (rewired behind the runtime governance
// broker — no longer sends directly / holds the credential). Their
// INTERFACE signature lines are UNCHANGED, so they remain in OTHER_LEGACY
// for the interface checks; only their scaffold bodies are excluded from
// the byte-identity assertions.
const SCAFFOLD_CHANGED = new Set(['web_search', 'email_send']);
const scaffoldChangedPaths = new Set(
  [...SCAFFOLD_CHANGED].map((n) => 'src/lib/tools/' + n + '.ts'),
);
const SCAFFOLD_FROZEN = LEGACY_TOOL_NAMES.filter((n) => !SCAFFOLD_CHANGED.has(n));

// ===========================================================================
// 1 + 2 — SCAFFOLD FILES BYTE-IDENTICAL (the 7 unchanged tools)
// ===========================================================================
describe('equivalence — shipped scaffold files', () => {
  it('every scaffold file EXCEPT the intentionally-changed ones is byte-identical to the baseline', () => {
    for (const pre of baseline.scaffoldFiles) {
      if (scaffoldChangedPaths.has(pre.path)) continue;
      const post = SCAFFOLD_FILES.find((f) => f.path === pre.path);
      expect(post, 'derived has ' + pre.path).toBeDefined();
      expect(post!.content, pre.path + ' byte-identical').toBe(pre.content);
    }
  });

  it('each of the 6 byte-frozen legacy tool source files ships byte-identical', () => {
    for (const name of SCAFFOLD_FROZEN) {
      const filePath = 'src/lib/tools/' + name + '.ts';
      const pre = baseline.scaffoldFiles.find((f) => f.path === filePath);
      const post = SCAFFOLD_FILES.find((f) => f.path === filePath);
      expect(pre, 'baseline has ' + filePath).toBeDefined();
      expect(post, 'derived has ' + filePath).toBeDefined();
      expect(post!.content).toBe(pre!.content);
    }
  });

  it('web_search.ts was DELIBERATELY upgraded to the Brave provider-backed source', () => {
    // This is the one legacy baseline we update on purpose. The new
    // source uses the Brave endpoint + the X-Subscription-Token header,
    // self-mocks on FORGE_MOCK_TOOLS=1, and no longer reads the old
    // WEB_SEARCH_URL env var.
    const path = 'src/lib/tools/web_search.ts';
    const pre = baseline.scaffoldFiles.find((f) => f.path === path)!;
    const post = SCAFFOLD_FILES.find((f) => f.path === path)!;
    expect(post.content).not.toBe(pre.content); // changed on purpose
    expect(post.content).toContain('api.search.brave.com/res/v1/web/search');
    expect(post.content).toContain('X-Subscription-Token');
    expect(post.content).toContain('BRAVE_SEARCH_API_KEY');
    expect(post.content).toContain('isMockMode'); // still self-mocks
    expect(post.content).not.toContain('WEB_SEARCH_URL'); // old stub gone
  });

  it('email_send.ts was DELIBERATELY rewired behind the governance broker', () => {
    // The governed change: the agent no longer sends directly and no longer
    // holds the email credential. Its scaffold must NOT reference
    // RESEND_API_KEY, names the governed model, and its real branch is an
    // honest governed throw — never a fake send. The mock branch stays for
    // sandbox smoke and is unmistakably a mock.
    const path = 'src/lib/tools/email_send.ts';
    const pre = baseline.scaffoldFiles.find((f) => f.path === path)!;
    const post = SCAFFOLD_FILES.find((f) => f.path === path)!;
    expect(post.content).not.toBe(pre.content); // changed on purpose
    expect(post.content).toContain('GOVERNED'); // names the governed model
    expect(post.content).not.toContain('RESEND_API_KEY'); // artifact never holds the key
    expect(post.content).toContain('isMockMode'); // mock branch preserved
    expect(post.content).toContain("message_id: 'mock-'"); // mock is unmistakably mock
  });

  it('the boilerplate files (package.json, tsconfig, README, types, index, runtime) are byte-identical', () => {
    for (const filePath of [
      'package.json',
      'tsconfig.json',
      'README.md',
      'src/lib/tools/types.ts',
      'src/lib/tools/index.ts',
      'src/lib/runtime.ts',
    ]) {
      const pre = baseline.scaffoldFiles.find((f) => f.path === filePath);
      const post = SCAFFOLD_FILES.find((f) => f.path === filePath);
      expect(post!.content, filePath + ' byte-identical').toBe(pre!.content);
    }
  });

  it('the file ORDER is unchanged', () => {
    expect(SCAFFOLD_FILES.map((f) => f.path)).toEqual(
      baseline.scaffoldFiles.map((f) => f.path),
    );
  });
});

// ===========================================================================
// 3 — SCAFFOLD_TOOL_INTERFACE — 7 lines unchanged, web_search line updated
// ===========================================================================
function interfaceLine(blob: string, name: string): string {
  return (
    blob.split('\n').find((l) => l.startsWith('export const ' + name + ':')) ?? ''
  );
}

describe('equivalence — SCAFFOLD_TOOL_INTERFACE', () => {
  it("the 7 unchanged tools' interface signature lines are byte-identical", () => {
    for (const name of OTHER_LEGACY) {
      const pre = interfaceLine(baseline.scaffoldToolInterface, name);
      expect(pre.length, name + ' has a baseline line').toBeGreaterThan(0);
      expect(SCAFFOLD_TOOL_INTERFACE).toContain(pre);
    }
  });

  it("web_search's interface line was DELIBERATELY updated (limit? → count?)", () => {
    const preLine = interfaceLine(baseline.scaffoldToolInterface, 'web_search');
    expect(preLine).toContain('limit?: number'); // old shape
    // The old line is gone; the new line carries count? + the provider note.
    expect(SCAFFOLD_TOOL_INTERFACE).not.toContain(preLine);
    const newLine = interfaceLine(SCAFFOLD_TOOL_INTERFACE, 'web_search');
    expect(newLine).toContain('count?: number');
    expect(newLine).toContain('brave_search');
  });
});

// ===========================================================================
// 4 — TOOL_REGISTRY entries field-identical for the 8 tools
// ===========================================================================
describe('equivalence — TOOL_REGISTRY entries (8 legacy tools)', () => {
  it('each legacy tool entry is field-identical pre/post (id/label/description/env_keys/status)', () => {
    for (const name of LEGACY_TOOL_NAMES) {
      const pre = baseline.toolRegistry.find((t) => t.id === name);
      const post = TOOL_REGISTRY.find((t) => t.id === name);
      expect(pre, 'baseline registry has ' + name).toBeDefined();
      expect(post, 'derived registry has ' + name).toBeDefined();
      expect({
        id: post!.id,
        label: post!.label,
        description: post!.description,
        env_keys: [...post!.env_keys],
        status: post!.status,
      }).toEqual(pre);
    }
  });

  it('the 8 legacy tools appear FIRST in the derived registry, in their original order', () => {
    const first8 = TOOL_REGISTRY.slice(0, 8).map((t) => t.id);
    expect(first8).toEqual(LEGACY_TOOL_NAMES);
  });
});

// ===========================================================================
// 5 — CODEGEN TOOLS SECTION render-identical
//
// The codegen TOOLS section is produced inside buildCodegenUserMessage
// via sectionTools()/renderTool() which read TOOL_REGISTRY. We render
// a message with a plan that uses the 8 tools and assert the per-tool
// TOOLS lines match what the pre-migration registry would have
// produced (reconstructed from the baseline registry entries with the
// same renderTool formatting).
// ===========================================================================

function reconstructToolLine(
  entry: { id: string; label: string; description: string; env_keys: string[] },
  why: string | null,
): string {
  const env =
    entry.env_keys.length === 0
      ? 'no env required'
      : 'env: ' + entry.env_keys.join(', ');
  const whyTail = why ? '  // why: ' + why : '';
  return (
    '  - ' + entry.id + '  [' + entry.label + '; ' + env + '] — ' + entry.description + whyTail
  );
}

describe('equivalence — codegen TOOLS section (8 legacy tools)', () => {
  it('every legacy tool renders the identical TOOLS line pre/post', () => {
    const spec: AgentSpec = AgentSpecSchema.parse({
      name: 'All Tools',
      goal: 'Exercise every legacy tool in one plan.',
      description: 'A synthetic agent that lists all 8 legacy tools.',
      trigger: 'schedule',
      runtime: 'on_demand',
      inputs: [{ name: 'x', description: 'input' }],
      capabilities: [
        { tool: 'web_search', why: 'why ws' },
        { tool: 'http_request', why: 'why http' },
        { tool: 'llm_completion', why: 'why llm' },
        { tool: 'file_read', why: 'why fr' },
        { tool: 'file_write', why: 'why fw' },
        { tool: 'schedule', why: 'why sch' },
        { tool: 'email_read', why: 'why er' },
        { tool: 'email_send', why: 'why es' },
      ],
      outputs: [{ name: 'y', description: 'output' }],
      constraints: [],
      success_criteria: ['done'],
      risk: 'low',
      confidence: 0.9,
    });
    const whyByTool: Record<string, string> = {
      web_search: 'why ws',
      http_request: 'why http',
      llm_completion: 'why llm',
      file_read: 'why fr',
      file_write: 'why fw',
      schedule: 'why sch',
      email_read: 'why er',
      email_send: 'why es',
    };
    const plan: BuildPlan = BuildPlanSchema.parse({
      scaffold: 'agent-node-tool-using',
      target: { framework: 'nodejs', hosting: 'vercel_function', entrypoint: 'src/index.ts' },
      trigger_impl: 'manual',
      runtime_impl: 'on_demand',
      tools: LEGACY_TOOL_NAMES.map((name) => {
        const entry = baseline.toolRegistry.find((t) => t.id === name)!;
        return {
          requested: name,
          status: entry.status === 'needs_key' ? 'needs_key' : 'supported',
          registry_id: name,
          env_keys: entry.env_keys,
        };
      }),
      files: [{ path: 'src/index.ts', purpose: 'entry' }],
      env_required: [],
      tasks: [{ id: 't', title: 't', description: 't', depends_on: [] }],
      estimate: { risk: 'low', complexity: 'low', notes: 'n' },
      warnings: [],
    });

    const message = buildCodegenUserMessage({
      spec,
      plan,
      filePath: 'src/index.ts',
      filePurpose: 'entry',
      allFiles: [{ path: 'src/index.ts', purpose: 'entry', source: 'generated' }],
    });

    for (const name of LEGACY_TOOL_NAMES) {
      const entry = baseline.toolRegistry.find((t) => t.id === name)!;
      const expectedLine = reconstructToolLine(entry, whyByTool[name] ?? null);
      expect(message, 'TOOLS line for ' + name).toContain(expectedLine);
    }
  });
});
