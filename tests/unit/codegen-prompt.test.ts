// Hermetic unit test — codegen prompt assembly.
//
// Tests the PROMPT BUILDER, not the LLM output. Given a sample
// (spec, plan, tool interface, handoff?), the builder must produce
// a prompt that contains:
//
//   - The engine's QUALITY_BAR criteria (system prompt)
//   - The file PURPOSE
//   - INPUTS + OUTPUTS sections with the declared items
//   - TOOLS section with each tool's id + env + the why-from-spec
//   - The SCAFFOLD INTERFACE text verbatim
//   - The PLAN ROLE — scaffold, target, tasks, file list
//   - The HANDOFF CONTRACT section ONLY when args.handoffContract is set
//   - The WORKED EXEMPLAR
//   - A FINAL INSTRUCTION naming the target path
//
// Stubbed: nothing — the prompt builder is a pure function over
// already-validated structs. No network, no LLM, no DB.

import { describe, expect, it } from 'vitest';
import {
  CODEGEN_SYSTEM_PROMPT,
  buildCodegenRepairMessage,
  buildCodegenSystemPrompt,
  buildCodegenUserMessage,
  type HandoffContract,
} from '@/lib/engine/codegen/prompts';
import {
  QUALITY_BAR,
  QUALITY_BAR_VERSION,
  qualityBarPromptBullets,
} from '@/lib/engine/codegen/quality';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';

// ---------------------------------------------------------------------------
// Fixtures — minimal but schema-valid spec + plan.
// ---------------------------------------------------------------------------
const sampleSpec: AgentSpec = AgentSpecSchema.parse({
  name: 'Daily Watch',
  goal: 'Notify when a watched URL changes.',
  description:
    'On a daily schedule, fetch a URL, compare its hash to the prior run, and emit a brief on change.',
  trigger: 'schedule',
  runtime: 'on_demand',
  inputs: [
    { name: 'watch_url', description: 'URL the agent monitors.' },
  ],
  capabilities: [
    { tool: 'http_request', why: 'Fetch the watched page.' },
    { tool: 'llm_completion', why: 'Summarise the diff.' },
  ],
  outputs: [{ name: 'change_brief', description: 'Short change summary.' }],
  constraints: ['One HTTP request per run.'],
  success_criteria: ['No brief on unchanged content.'],
  risk: 'low',
  confidence: 0.9,
});

const samplePlan: BuildPlan = BuildPlanSchema.parse({
  scaffold: 'agent-node-tool-using',
  target: {
    framework: 'nodejs',
    hosting: 'vercel_function',
    entrypoint: 'src/index.ts',
  },
  trigger_impl: 'Vercel cron at 09:00 UTC.',
  runtime_impl: 'on_demand',
  tools: [
    {
      requested: 'http_request',
      status: 'supported',
      registry_id: 'http_request',
      env_keys: [],
    },
    {
      requested: 'llm_completion',
      status: 'supported',
      registry_id: 'llm_completion',
      env_keys: ['ANTHROPIC_API_KEY'],
    },
  ],
  files: [
    { path: 'src/index.ts', purpose: 'Entrypoint that runs one watch cycle.' },
  ],
  env_required: [
    {
      key: 'ANTHROPIC_API_KEY',
      why: 'Required for llm_completion.',
      secret: true,
    },
  ],
  tasks: [
    {
      id: 'fetch_page',
      title: 'Fetch the watched URL',
      description: 'GET the URL.',
      depends_on: [],
    },
    {
      id: 'summarise',
      title: 'Summarise the diff',
      description: 'LLM call on change.',
      depends_on: ['fetch_page'],
    },
  ],
  estimate: { risk: 'low', complexity: 'low', notes: 'small project' },
  warnings: [],
});

const sampleInterface = `// src/lib/tools/types.ts
export interface ToolContext { readonly env: NodeJS.ProcessEnv; readonly log: (m: string) => void; }
export const http_request:   Tool<{ url: string }, { status: number; body: string }>;
export const llm_completion: Tool<{ user: string }, { text: string }>;`;

const sampleAllFiles = [
  {
    path: 'src/index.ts',
    purpose: 'Entrypoint that runs one watch cycle.',
    source: 'generated' as const,
  },
  {
    path: 'src/lib/tools/index.ts',
    purpose: '(scaffolded boilerplate or library)',
    source: 'scaffold' as const,
  },
];

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================
describe('codegen system prompt — QUALITY_BAR embedded verbatim', () => {
  it('embeds every QUALITY_BAR criterion imperative', () => {
    for (const c of QUALITY_BAR) {
      expect(CODEGEN_SYSTEM_PROMPT).toContain(c.label);
      expect(CODEGEN_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('records the QUALITY_BAR version so reports tie back to the bar', () => {
    expect(CODEGEN_SYSTEM_PROMPT).toContain(
      'QUALITY BAR (v' + QUALITY_BAR_VERSION + ')',
    );
  });

  it('reproduces qualityBarPromptBullets() inside the prompt', () => {
    // Single source of truth — the system prompt MUST render the
    // exact bullets the helper produces. If this drifts the
    // generator could ship under-instructed.
    expect(CODEGEN_SYSTEM_PROMPT).toContain(qualityBarPromptBullets());
  });

  it('forbids TODO / FIXME comments in output explicitly', () => {
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/TODO/);
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/FIXME/);
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/Output ONLY the file contents/);
  });

  it('keeps the scaffold conventions (ES modules, .js imports, strict mode)', () => {
    // The actual phrase is "`.js` extensions" (with backticks) — match
    // the surrounding context rather than the exact punctuation.
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/Local imports MUST use/);
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/strict mode/);
    expect(CODEGEN_SYSTEM_PROMPT).toMatch(/\.\/lib\/tools\/index\.js/);
  });
});

// ===========================================================================
// USER MESSAGE — single-agent (no handoff contract)
// ===========================================================================
describe('codegen user message — Phase 1 single-agent file', () => {
  const message = buildCodegenUserMessage({
    spec: sampleSpec,
    plan: samplePlan,
    filePath: 'src/index.ts',
    filePurpose: 'Entrypoint that runs one watch cycle.',
    allFiles: sampleAllFiles,
  });

  it('has every required section in order', () => {
    // Sections should appear in this fixed order. We assert by
    // checking ordered substring positions.
    // SCAFFOLD INTERFACE + WORKED EXEMPLAR moved to the cached system
    // block (buildCodegenSystemPrompt) — they're forge-stable reference
    // material, no longer repeated in the per-file user message.
    const sections = [
      'PURPOSE',
      'INPUTS',
      'OUTPUTS',
      'TOOLS AVAILABLE',
      'ROLE IN PLAN',
      'GENERATE THIS FILE NOW',
    ];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = message.indexOf(s);
      expect(idx, "section '" + s + "' present").toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('does NOT include the HANDOFF CONTRACT section (Phase 1 has none)', () => {
    expect(message).not.toContain('HANDOFF CONTRACT');
  });

  it('surfaces the file path + purpose in PURPOSE + final instruction', () => {
    expect(message).toContain('This file: src/index.ts');
    expect(message).toContain('File purpose: Entrypoint that runs one watch cycle.');
    expect(message).toContain('Path:    src/index.ts');
  });

  it('lists each declared input by name + description', () => {
    expect(message).toContain('watch_url :: URL the agent monitors.');
  });

  it('lists each declared output by name + description', () => {
    expect(message).toContain('change_brief :: Short change summary.');
  });

  it('renders each tool with id + env + the why-from-spec', () => {
    // http_request — no env, with the spec\'s "why" appended
    expect(message).toMatch(/http_request\s+\[HTTP request;\s+no env required\]/);
    expect(message).toContain('why: Fetch the watched page.');
    // llm_completion — env: ANTHROPIC_API_KEY
    expect(message).toMatch(
      /llm_completion\s+\[LLM completion;\s+env: ANTHROPIC_API_KEY\]/,
    );
    expect(message).toContain('why: Summarise the diff.');
  });

  it('no longer includes the SCAFFOLD INTERFACE in the user message (moved to cached system block)', () => {
    expect(message).not.toContain('SCAFFOLD INTERFACE');
  });

  it('surfaces the plan role: scaffold, target, tasks, all files', () => {
    expect(message).toContain('Scaffold: agent-node-tool-using');
    expect(message).toMatch(/Target framework: nodejs/);
    expect(message).toContain('fetch_page :: Fetch the watched URL');
    expect(message).toContain('summarise :: Summarise the diff (after: fetch_page)');
    expect(message).toContain('src/index.ts  [generated]: Entrypoint');
    expect(message).toContain('src/lib/tools/index.ts  [scaffold]:');
  });

  it('no longer embeds the WORKED EXEMPLAR in the user message (moved to cached system block)', () => {
    expect(message).not.toContain('WORKED EXEMPLAR');
    expect(message).not.toContain('normaliseName');
  });
});

// ===========================================================================
// CACHED SYSTEM BLOCK — system prompt + forge-stable reference material
// ===========================================================================
describe('buildCodegenSystemPrompt — cached prefix (system + exemplar + scaffold)', () => {
  const systemBlock = buildCodegenSystemPrompt({ toolInterface: sampleInterface });

  it('still embeds the QUALITY_BAR (base system prompt) verbatim', () => {
    expect(systemBlock).toContain(qualityBarPromptBullets());
    expect(systemBlock).toContain(CODEGEN_SYSTEM_PROMPT);
  });

  it('embeds the WORKED EXEMPLAR with a "do not copy verbatim" disclaimer', () => {
    expect(systemBlock).toMatch(/WORKED EXEMPLAR.*DO NOT COPY VERBATIM/);
    expect(systemBlock).toContain('normaliseName');
    expect(systemBlock).toMatch(/throw new Error\(.normaliseName:/);
    // NB: the system prompt legitimately contains the word "TODO" in its
    // "Do NOT include TODO" rule, so we don't assert its absence over the
    // whole block — only that the exemplar code itself has none.
    const exemplar = systemBlock.match(/WORKED EXEMPLAR[\s\S]*?```([\s\S]*?)```/);
    expect(exemplar).not.toBeNull();
    expect(exemplar![1]).not.toMatch(/\bTODO\b/);
  });

  it('embeds the SCAFFOLD INTERFACE text verbatim', () => {
    expect(systemBlock).toContain('SCAFFOLD INTERFACE');
    expect(systemBlock).toContain(sampleInterface.trim());
  });

  it('is DETERMINISTIC: identical bytes for the same scaffold interface', () => {
    const a = buildCodegenSystemPrompt({ toolInterface: sampleInterface });
    const b = buildCodegenSystemPrompt({ toolInterface: sampleInterface });
    expect(a).toBe(b);
    // No timestamps / random ids leak into the cached prefix.
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ===========================================================================
// USER MESSAGE — system node (with handoff contract)
// ===========================================================================
describe('codegen user message — Phase 2 system-node file', () => {
  const handoff: HandoffContract = {
    selfNodeId: 'summariser',
    upstream: [{ fromNodeId: 'gatherer', payload: 'raw_items' }],
    downstream: [{ toNodeId: 'brief_writer', payload: 'item_summaries' }],
    declaredOutputs: ['item_summaries'],
  };
  const message = buildCodegenUserMessage({
    spec: sampleSpec,
    plan: samplePlan,
    filePath: 'src/modules/summariser/index.ts',
    filePurpose: 'Per-source summariser sub-agent.',
    allFiles: sampleAllFiles,
    handoffContract: handoff,
  });

  it('includes a dedicated HANDOFF CONTRACT section', () => {
    expect(message).toContain('HANDOFF CONTRACT');
    expect(message).toContain("node 'summariser'");
  });

  it('lists upstream nodes with payload labels', () => {
    expect(message).toContain('from gatherer :: raw_items');
  });

  it('lists downstream consumers with payload labels', () => {
    expect(message).toContain('to brief_writer :: item_summaries');
  });

  it('declares the exact output keys the orchestrator will read', () => {
    expect(message).toContain('declared outputs');
    expect(message).toContain('item_summaries');
  });

  it('instructs the file to export the named `run` function', () => {
    expect(message).toContain('Export the contract:');
    expect(message).toMatch(/async function `run\(input:/);
  });

  it('places HANDOFF CONTRACT between ROLE IN PLAN and the final instruction', () => {
    // WORKED EXEMPLAR moved to the cached system block, so the handoff
    // now sits between ROLE IN PLAN and GENERATE THIS FILE NOW.
    const roleIdx = message.indexOf('ROLE IN PLAN');
    const handoffIdx = message.indexOf('HANDOFF CONTRACT');
    const finalIdx = message.indexOf('GENERATE THIS FILE NOW');
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(handoffIdx).toBeGreaterThan(roleIdx);
    expect(finalIdx).toBeGreaterThan(handoffIdx);
  });

  it('represents external (null fromNodeId) inputs explicitly', () => {
    const triggerHandoff: HandoffContract = {
      selfNodeId: 'first',
      upstream: [{ fromNodeId: null, payload: 'trigger_payload' }],
      downstream: [],
      declaredOutputs: ['initial_state'],
    };
    const m = buildCodegenUserMessage({
      spec: sampleSpec,
      plan: samplePlan,
        filePath: 'src/modules/first/index.ts',
      filePurpose: 'First node — receives trigger payload.',
      allFiles: sampleAllFiles,
      handoffContract: triggerHandoff,
    });
    expect(m).toContain('from (external trigger) :: trigger_payload');
    expect(m).toContain('downstream: (none — last node in the pipeline)');
  });
});

// ===========================================================================
// REPAIR MESSAGE
// ===========================================================================
describe('codegen repair message', () => {
  it('echoes the esbuild error and re-asserts the QUALITY BAR', () => {
    const msg = buildCodegenRepairMessage('Unexpected token at line 7');
    expect(msg).toContain('esbuild rejected your previous output:');
    expect(msg).toContain('Unexpected token at line 7');
    expect(msg).toContain('No prose');
    expect(msg).toContain('QUALITY BAR');
  });
});
