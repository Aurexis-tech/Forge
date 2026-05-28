// TOOLS — public barrel.
//
// Importing this module registers ALL engine tools into the
// in-process registry as a side effect:
//   - the 8 builtin planner tools (web_search … email_send)
//   - the seed tools (compute_math, parse_json, compute_text_transform,
//     compute_regex_extract, parse_url, parse_csv)
// then re-exports the public API:
//
//   - registerTool, getToolByName, listTools (registry)
//   - callTool, callToolTyped (sandbox bridge)
//   - toolsSectionForPrompt (codegen presentation)
//   - ToolDefinition + supporting types (contract)
//
// This barrel is the SINGLE registration point. Every consumer that
// reads the registry (planner registry derivation, scaffold file
// map, codegen TOOLS section) imports from here so registration is
// guaranteed to have run.
//
// Side-effect import is guarded by an idempotency flag so the barrel
// can be imported multiple times without duplicate-name errors.

import { registerTool, getToolByName } from './registry';
import {
  COMPUTE_MATH,
  PARSE_JSON,
  COMPUTE_TEXT_TRANSFORM,
  COMPUTE_REGEX_EXTRACT,
  PARSE_URL,
  PARSE_CSV,
} from './seed';
import { PLANNER_TOOLS } from './builtin';
import type { ToolDefinition } from './contract';

let toolsRegistered = false;

// Canonical registration order: the 8 builtin planner tools first
// (in their legacy order), then the seed tools (batch 1 + batch 2).
const ALL_TOOLS: ReadonlyArray<ToolDefinition> = [
  ...PLANNER_TOOLS,
  COMPUTE_MATH as unknown as ToolDefinition,
  PARSE_JSON as unknown as ToolDefinition,
  COMPUTE_TEXT_TRANSFORM as unknown as ToolDefinition,
  COMPUTE_REGEX_EXTRACT as unknown as ToolDefinition,
  PARSE_URL as unknown as ToolDefinition,
  PARSE_CSV as unknown as ToolDefinition,
];

/**
 * Register every engine tool. Idempotent: a tool already present is
 * skipped, so a reset-then-re-register cycle in tests works without
 * duplicate-name errors.
 */
export function ensureToolsRegistered(): void {
  if (toolsRegistered && getToolByName(COMPUTE_MATH.name)) return;
  for (const tool of ALL_TOOLS) {
    if (!getToolByName(tool.name)) registerTool(tool);
  }
  toolsRegistered = true;
}

// Back-compat alias — earlier code + tests referenced this name.
export function ensureSeedToolsRegistered(): void {
  ensureToolsRegistered();
}

ensureToolsRegistered();

/**
 * Test-only: reset the registration flag so a subsequent
 * `_resetRegistryForTests()` followed by `ensureToolsRegistered()`
 * actually re-registers.
 */
export function _resetSeedFlagForTests(): void {
  toolsRegistered = false;
}

export {
  registerTool,
  getToolByName,
  listTools,
  ToolRegistrationError,
  _resetRegistryForTests,
} from './registry';
export {
  callTool,
  callToolTyped,
  ToolSchemaError,
} from './sandbox-bridge';
export {
  toolsSectionForPrompt,
  renderToolBlock,
  UnknownToolError,
} from './codegen-presentation';
export {
  collectToolDependencies,
  mergePackageJsonDependencies,
  dedupeSelectedToolNames,
} from './scaffold-dependencies';
export {
  NeedsConnectionError,
  requiredProviderConnections,
  buildProviderConnectionEnv,
  listToolProviderConnections,
  type ProviderKeyLookup,
} from './provider-connections';
export {
  verifyProviderKey,
  type VerifyFetch,
  type VerifyResult,
} from './verify-provider-key';
export type {
  ToolDefinition,
  ToolContext,
  ToolCategory,
  ToolCapabilities,
  ToolExample,
  ToolPlannerStatus,
  ToolProviderConnection,
} from './contract';
export { TOOL_CATEGORIES, TOOL_NAME_PATTERN, TOOL_PLANNER_STATUSES } from './contract';
export {
  COMPUTE_MATH,
  PARSE_JSON,
  COMPUTE_TEXT_TRANSFORM,
  COMPUTE_REGEX_EXTRACT,
  PARSE_URL,
  PARSE_CSV,
} from './seed';
export {
  PLANNER_TOOLS,
  PLANNER_TOOL_NAMES,
  WEB_SEARCH_TOOL,
  HTTP_REQUEST_TOOL,
  LLM_COMPLETION_TOOL,
  FILE_READ_TOOL,
  FILE_WRITE_TOOL,
  SCHEDULE_TOOL,
  EMAIL_READ_TOOL,
  EMAIL_SEND_TOOL,
} from './builtin';
