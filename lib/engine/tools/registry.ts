// TOOL REGISTRY — central registration with validation.
//
// USAGE
//   import { registerTool } from '@/lib/engine/tools/registry';
//   import { COMPUTE_MATH } from './seed/compute-math';
//   registerTool(COMPUTE_MATH);
//
// VALIDATION at registration time:
//   1. `name` is unique + matches TOOL_NAME_PATTERN.
//   2. `description` non-empty.
//   3. `category` is a known TOOL_CATEGORIES entry.
//   4. `capabilities` is a complete shape (no missing booleans).
//   5. `input_schema` / `output_schema` are real Zod schemas.
//   6. `runtime` / `mock` are functions of arity 2.
//   7. `examples` has ≥2 entries; every input + output parses
//      against the schemas.
//
// CAPABILITIES-HONESTY ENFORCEMENT is separate — done as a
// static-shape sweep test (tests/unit/tool-capability-sweep.test.ts)
// rather than inline here. We could try to detect `fetch` in
// runtime.toString(), but minified / bundled code defeats the
// regex; a test that walks every registered tool's runtime source
// is the durable guarantee.

import type { ZodType } from 'zod';
import {
  type ToolCapabilities,
  type ToolCategory,
  type ToolDefinition,
  TOOL_CATEGORIES,
  TOOL_NAME_PATTERN,
} from './contract';

/**
 * The in-process registry. A single map keyed by `name`. The
 * module is loaded once per Node worker, so registration order
 * doesn't matter as long as every seed module is imported before
 * any consumer reads from the registry.
 */
const REGISTRY = new Map<string, ToolDefinition<unknown, unknown>>();

/** Error thrown when a tool fails registration validation. */
export class ToolRegistrationError extends Error {
  constructor(
    public readonly name: string,
    public readonly reason: string,
  ) {
    super(
      'tool registration failed for ' + JSON.stringify(name) + ': ' + reason,
    );
    this.name = 'ToolRegistrationError';
  }
}

/**
 * Register a tool. Throws `ToolRegistrationError` synchronously
 * on any validation failure — caught early at module-load time
 * rather than blowing up an LLM call deep in codegen.
 */
export function registerTool<I, O>(def: ToolDefinition<I, O>): void {
  // Cast to the registry's unknown-keyed shape. The schemas
  // remain the source of truth at the boundary.
  const erased = def as unknown as ToolDefinition<unknown, unknown>;
  validateDefinition(erased);
  REGISTRY.set(erased.name, erased);
}

/** Look up a tool by name. Returns null when missing. */
export function getToolByName(name: string): ToolDefinition | null {
  const entry = REGISTRY.get(name);
  return entry ?? null;
}

/** Filter used by `listTools`. */
export interface ListToolsFilter {
  readonly category?: ToolCategory;
  /** When true, return only tools that declare reads_network:false. */
  readonly local_only?: boolean;
}

/**
 * Enumerate registered tools. Deterministic ordering — sorted by
 * `name` so callers (codegen presentation, debug pages) get a
 * stable list.
 */
export function listTools(filter?: ListToolsFilter): ReadonlyArray<ToolDefinition> {
  const all = Array.from(REGISTRY.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (!filter) return all;
  return all.filter((t) => {
    if (filter.category && t.category !== filter.category) return false;
    if (filter.local_only && t.capabilities.reads_network) return false;
    return true;
  });
}

/**
 * Test-only: clear the registry. Production code should NEVER
 * call this. Exported for hermetic tests that need a clean slate
 * before registering fixtures.
 */
export function _resetRegistryForTests(): void {
  REGISTRY.clear();
}

// ---------------------------------------------------------------------------
// Internals — validation.
// ---------------------------------------------------------------------------

function validateDefinition(def: ToolDefinition<unknown, unknown>): void {
  // --- name ---
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new ToolRegistrationError(String(def.name), 'name must be a non-empty string');
  }
  if (!TOOL_NAME_PATTERN.test(def.name)) {
    throw new ToolRegistrationError(
      def.name,
      'name must match ' + TOOL_NAME_PATTERN.source,
    );
  }
  if (REGISTRY.has(def.name)) {
    throw new ToolRegistrationError(
      def.name,
      'a tool with this name is already registered',
    );
  }

  // --- description ---
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new ToolRegistrationError(def.name, 'description must be a non-empty string');
  }

  // --- category ---
  if (!TOOL_CATEGORIES.includes(def.category)) {
    throw new ToolRegistrationError(
      def.name,
      'category must be one of: ' + TOOL_CATEGORIES.join(', '),
    );
  }

  // --- capabilities ---
  if (!isCompleteCapabilities(def.capabilities)) {
    throw new ToolRegistrationError(
      def.name,
      'capabilities must declare reads_network, writes_external, destructive (all boolean)',
    );
  }

  // --- schemas ---
  if (!isZodSchema(def.input_schema)) {
    throw new ToolRegistrationError(def.name, 'input_schema must be a Zod schema');
  }
  if (!isZodSchema(def.output_schema)) {
    throw new ToolRegistrationError(def.name, 'output_schema must be a Zod schema');
  }

  // --- runtime / mock ---
  // Function-typed only — we don't enforce arity because JS lets
  // a callee declare fewer params than callers pass, and many
  // pure tools don't need ctx. The bridge always passes both.
  if (typeof def.runtime !== 'function') {
    throw new ToolRegistrationError(
      def.name,
      'runtime must be a function (input, ctx) => Promise<output>',
    );
  }
  if (typeof def.mock !== 'function') {
    throw new ToolRegistrationError(
      def.name,
      'mock must be a function (input, ctx) => Promise<output>',
    );
  }

  // --- scaffold shipping ---
  if (typeof def.scaffoldSource !== 'string' || def.scaffoldSource.trim().length === 0) {
    throw new ToolRegistrationError(
      def.name,
      'scaffoldSource must be a non-empty string (the .ts source shipped into the generated agent)',
    );
  }
  if (
    typeof def.scaffoldInterfaceSignature !== 'string' ||
    def.scaffoldInterfaceSignature.trim().length === 0
  ) {
    throw new ToolRegistrationError(
      def.name,
      'scaffoldInterfaceSignature must be a non-empty string',
    );
  }
  if (def.scaffoldDependencies !== undefined) {
    if (typeof def.scaffoldDependencies !== 'object' || def.scaffoldDependencies === null) {
      throw new ToolRegistrationError(
        def.name,
        'scaffoldDependencies must be an object of { package: versionRange }',
      );
    }
    for (const [pkg, version] of Object.entries(def.scaffoldDependencies)) {
      if (typeof version !== 'string' || version.length === 0) {
        throw new ToolRegistrationError(
          def.name,
          'scaffoldDependencies["' + pkg + '"] must be a non-empty version string',
        );
      }
    }
  }

  // --- planner-compat ---
  if (typeof def.plannerLabel !== 'string' || def.plannerLabel.trim().length === 0) {
    throw new ToolRegistrationError(def.name, 'plannerLabel must be a non-empty string');
  }
  if (
    !Array.isArray(def.envKeys) ||
    def.envKeys.some((k) => typeof k !== 'string')
  ) {
    throw new ToolRegistrationError(def.name, 'envKeys must be an array of strings');
  }
  if (def.status !== 'available' && def.status !== 'needs_key') {
    throw new ToolRegistrationError(
      def.name,
      "status must be 'available' or 'needs_key'",
    );
  }

  // --- provider_connection (provider-backed tools) ---
  if (def.provider_connection !== undefined) {
    const pc = def.provider_connection;
    if (typeof pc !== 'object' || pc === null) {
      throw new ToolRegistrationError(
        def.name,
        'provider_connection must be an object',
      );
    }
    for (const field of ['provider', 'label', 'env_key'] as const) {
      if (typeof pc[field] !== 'string' || pc[field].trim().length === 0) {
        throw new ToolRegistrationError(
          def.name,
          'provider_connection.' + field + ' must be a non-empty string',
        );
      }
    }
    if (pc.env_key.startsWith('NEXT_PUBLIC_')) {
      throw new ToolRegistrationError(
        def.name,
        'provider_connection.env_key must be SERVER-ONLY (never NEXT_PUBLIC_)',
      );
    }
    if (pc.setup_url !== undefined && typeof pc.setup_url !== 'string') {
      throw new ToolRegistrationError(def.name, 'provider_connection.setup_url must be a string');
    }
    if (pc.verify !== undefined) {
      for (const field of ['url', 'method', 'header'] as const) {
        if (typeof pc.verify[field] !== 'string' || pc.verify[field].length === 0) {
          throw new ToolRegistrationError(
            def.name,
            'provider_connection.verify.' + field + ' must be a non-empty string',
          );
        }
      }
    }
    // CAPABILITY HONESTY: a provider-backed tool reaches the network.
    if (def.capabilities.reads_network !== true) {
      throw new ToolRegistrationError(
        def.name,
        'a tool with provider_connection MUST declare capabilities.reads_network:true',
      );
    }
  }

  // --- examples ---
  if (!Array.isArray(def.examples) || def.examples.length < 2) {
    throw new ToolRegistrationError(
      def.name,
      'examples must be an array of ≥2 entries',
    );
  }
  for (let i = 0; i < def.examples.length; i++) {
    const ex = def.examples[i]!;
    if (typeof ex.label !== 'string' || ex.label.trim().length === 0) {
      throw new ToolRegistrationError(
        def.name,
        'example[' + i + '].label must be a non-empty string',
      );
    }
    const inParsed = def.input_schema.safeParse(ex.input);
    if (!inParsed.success) {
      throw new ToolRegistrationError(
        def.name,
        'example[' + i + '].input does not parse against input_schema: ' +
          summariseZodError(inParsed.error),
      );
    }
    const outParsed = def.output_schema.safeParse(ex.output);
    if (!outParsed.success) {
      throw new ToolRegistrationError(
        def.name,
        'example[' + i + '].output does not parse against output_schema: ' +
          summariseZodError(outParsed.error),
      );
    }
  }
}

function isCompleteCapabilities(c: unknown): c is ToolCapabilities {
  if (typeof c !== 'object' || c === null) return false;
  const cap = c as Record<string, unknown>;
  return (
    typeof cap.reads_network === 'boolean' &&
    typeof cap.writes_external === 'boolean' &&
    typeof cap.destructive === 'boolean'
  );
}

function isZodSchema(x: unknown): x is ZodType {
  // Zod schemas are objects with a `safeParse` method. We don't
  // check the prototype chain because mocks may swap in a custom
  // base; duck-typing on the public method is enough.
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.safeParse === 'function' && typeof obj.parse === 'function';
}

function summariseZodError(err: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> }): string {
  return err.issues
    .map((i) => '[' + i.path.join('.') + '] ' + i.message)
    .join('; ');
}
