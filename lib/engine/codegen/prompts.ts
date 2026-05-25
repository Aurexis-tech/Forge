// Prompts for the codegen LLM. One file is generated per LLM call so the
// model can focus, the static check is per-file, and errors localise.

import type { AgentSpec } from '../spec/schema';
import type { BuildPlan } from '../planner/schema';

export const CODEGEN_SYSTEM_PROMPT = `You are the Aurexis Forge codegen worker.

You generate the contents of ONE file in a Node.js TypeScript agent project. The project's package.json, tsconfig.json, runtime harness, and tool library are already scaffolded — you MUST use them, never reimplement them.

OUTPUT RULES — non-negotiable:
- Output ONLY the file contents. No prose. No markdown code fences. No commentary.
- Begin with the very first character of the file (e.g. \`import\`, \`{\`, \`//\`).
- Do not include the file path, do not include a "Here is the file:" preamble.

CODE RULES:
- ES module syntax. Local imports MUST use \`.js\` extensions (e.g. \`import { web_search } from './lib/tools/index.js';\`).
- TypeScript strict mode is on. Type everything; no implicit any.
- Use ONLY the tools exported from \`./lib/tools/index.js\` for capability invocations. Never reimplement web search, HTTP, LLM calls, file I/O, scheduling, or email. Never invent new tool ids.
- Use the runtime harness from \`./lib/runtime.js\` — \`defineAgent\`, \`asApiHandler\`, \`asWebhookHandler\`, \`runChatStdin\`, \`runOnce\`, \`createContext\` — for trigger plumbing.
- All configuration comes from \`process.env\`. Never hardcode API keys, URLs, sender addresses, or other secrets.
- Stay within the dependencies declared in package.json (@anthropic-ai/sdk) plus Node built-ins (node:fs/promises, node:path, etc).
- Prefer pure functions; isolate side effects in tool calls.

You will receive: the confirmed AgentSpec, the approved BuildPlan, the scaffold's tool/runtime TypeScript interface, the full list of planned files (for context), and the specific file you must generate with its purpose. Generate ONLY that file.`;

export interface CodegenUserMessageArgs {
  spec: AgentSpec;
  plan: BuildPlan;
  toolInterface: string;
  filePath: string;
  filePurpose: string;
  allFiles: ReadonlyArray<{
    path: string;
    purpose: string;
    source: 'scaffold' | 'generated';
  }>;
}

export function buildCodegenUserMessage(args: CodegenUserMessageArgs): string {
  const fileList = args.allFiles
    .map((f) => '  - ' + f.path + '  [' + f.source + ']: ' + f.purpose)
    .join('\n');

  return [
    'AGENT SPEC:',
    JSON.stringify(args.spec, null, 2),
    '',
    'BUILD PLAN:',
    JSON.stringify(args.plan, null, 2),
    '',
    'SCAFFOLD INTERFACE (the only modules you may import from this project):',
    args.toolInterface,
    '',
    'ALL FILES IN THIS BUILD (you are generating ONE of these):',
    fileList,
    '',
    'GENERATE THIS FILE NOW:',
    '  Path:    ' + args.filePath,
    '  Purpose: ' + args.filePurpose,
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file.',
  ].join('\n');
}

export function buildCodegenRepairMessage(error: string): string {
  return [
    'esbuild rejected your previous output:',
    '',
    error,
    '',
    'Return ONLY the corrected file content. No prose. No markdown code fences. Keep the file purpose and imports intact; fix the offending lines.',
  ].join('\n');
}
