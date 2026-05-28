// SANDBOX BRIDGE — the single switch point between mock + runtime.
//
// EVERY engine-internal tool invocation goes through `callTool`.
// The bridge decides whether to dispatch to `runtime` or `mock`
// based on `ctx.mode`. By construction, sandbox tests + dry-runs
// (which set `mode: 'mock'`) cannot reach a runtime implementation
// — there's no other entry point.
//
// HARD INVARIANTS
//   - Unknown tool name → throws `UnknownToolError` immediately.
//     The codegen path validates names against `toolsSectionForPrompt`
//     already, so this is defence-in-depth.
//   - Input is parsed against `input_schema` BEFORE dispatch.
//     Invalid input is rejected with a structured error rather
//     than handed to the tool body.
//   - Output is parsed against `output_schema` AFTER dispatch.
//     A tool whose runtime / mock returns a shape that doesn't
//     match its declared output_schema is a bug — surfaced loudly
//     rather than silently passed through.
//   - The structured logger is wired via `ctx.log` (the bridge
//     populates it). Tools should never reach for `console.log`.

import { engineLog } from '../log';
import type { ToolContext, ToolDefinition } from './contract';
import { getToolByName } from './registry';
import { UnknownToolError } from './codegen-presentation';

const log = engineLog('tools');

/** Caller-facing args for `callTool`. */
export interface CallToolArgs {
  readonly name: string;
  readonly input: unknown;
  /** 'runtime' | 'mock'. Default: 'mock' — fail-closed against accidental real I/O. */
  readonly mode?: 'runtime' | 'mock';
  /** Forwarded subset of process.env. The bridge does NOT leak full env by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Thrown when input or output fails schema validation. */
export class ToolSchemaError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly direction: 'input' | 'output',
    public readonly issues: string,
  ) {
    super(
      'tool ' +
        JSON.stringify(toolName) +
        ' ' +
        direction +
        ' did not match schema: ' +
        issues,
    );
    this.name = 'ToolSchemaError';
  }
}

/**
 * The single dispatch point. Looks the tool up by name, validates
 * input + output, and runs either `mock` or `runtime`.
 *
 * Defaults to 'mock' so a caller that forgets the mode flag
 * cannot accidentally fire real I/O. This is intentional: a
 * sandbox test that drops the explicit mode argument should still
 * stay hermetic.
 */
export async function callTool(args: CallToolArgs): Promise<unknown> {
  const tool = getToolByName(args.name);
  if (!tool) throw new UnknownToolError(args.name);

  // Validate input.
  const inParsed = tool.input_schema.safeParse(args.input);
  if (!inParsed.success) {
    throw new ToolSchemaError(
      args.name,
      'input',
      summariseZodIssues(inParsed.error),
    );
  }

  const mode = args.mode ?? 'mock';
  const ctx: ToolContext = {
    mode,
    env: args.env ?? {},
    log: (message, meta) =>
      log.info(message, { ...meta, tool: tool.name, mode }),
  };

  const out =
    mode === 'mock'
      ? await tool.mock(inParsed.data as never, ctx)
      : await tool.runtime(inParsed.data as never, ctx);

  // Validate output.
  const outParsed = tool.output_schema.safeParse(out);
  if (!outParsed.success) {
    throw new ToolSchemaError(
      args.name,
      'output',
      summariseZodIssues(outParsed.error),
    );
  }
  return outParsed.data;
}

/**
 * Typed convenience for callers that hold the ToolDefinition
 * statically (e.g. unit tests, codegen wiring). Skips the registry
 * lookup but preserves the schema validation + mode dispatch.
 */
export async function callToolTyped<I, O>(
  tool: ToolDefinition<I, O>,
  args: { input: I; mode?: 'runtime' | 'mock'; env?: Readonly<Record<string, string | undefined>> },
): Promise<O> {
  return callTool({
    name: tool.name,
    input: args.input,
    mode: args.mode,
    env: args.env,
  }) as Promise<O>;
}

function summariseZodIssues(err: {
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
}): string {
  return err.issues
    .map((i) => '[' + i.path.join('.') + '] ' + i.message)
    .join('; ');
}
