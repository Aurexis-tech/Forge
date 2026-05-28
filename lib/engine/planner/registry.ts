// The Forge's V1 tool registry — the ONLY tools the planner is allowed to
// ground spec capabilities against.
//
// ORIGIN CHANGE (tool-contract migration): this list is no longer
// hand-maintained here. It is DERIVED from the engine tool contract
// (lib/engine/tools). Each contract tool carries planner-compat fields
// (plannerLabel / envKeys / status) plus its LLM-facing description, from
// which a RegistryTool entry is built. The planner + system planner import
// TOOL_REGISTRY / findRegistryTool / registryForPrompt UNCHANGED — only the
// origin of the data moved from a hardcoded array to the contract.
//
// Adding a tool to the contract therefore makes it offerable by the planner
// automatically (alongside the codegen TOOLS section + shippable scaffold
// source, which derive from the same contract).
//
// `status` semantics:
//   - 'available' — tool runs with no extra setup from the user
//   - 'needs_key' — tool exists but requires the user to wire env keys before
//                   the agent can run; the plan surfaces this prominently

import {
  ensureToolsRegistered,
  listTools,
  PLANNER_TOOL_NAMES,
} from '@/lib/engine/tools';

export interface RegistryTool {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly env_keys: readonly string[];
  readonly status: 'available' | 'needs_key';
}

// Make sure every engine tool is registered before we derive.
ensureToolsRegistered();

/**
 * Deterministic ordering: the legacy 8 planner tools FIRST in their
 * canonical order (so the planner prompt stays stable for them), then
 * any additional contract tools sorted by name.
 */
function deriveRegistry(): RegistryTool[] {
  const byName = new Map(listTools().map((t) => [t.name, t]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const name of PLANNER_TOOL_NAMES) {
    if (byName.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const t of listTools()) {
    if (!seen.has(t.name)) ordered.push(t.name);
  }
  return ordered.map((name) => {
    const t = byName.get(name)!;
    return {
      id: t.name,
      label: t.plannerLabel,
      description: t.description,
      env_keys: [...t.envKeys],
      status: t.status,
    };
  });
}

export const TOOL_REGISTRY: readonly RegistryTool[] = deriveRegistry();

export function findRegistryTool(id: string): RegistryTool | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

// Compact JSON form the LLM consumes — keeps the prompt readable.
export function registryForPrompt(): string {
  return JSON.stringify(
    TOOL_REGISTRY.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      env_keys: t.env_keys,
      status: t.status,
    })),
    null,
    2,
  );
}
