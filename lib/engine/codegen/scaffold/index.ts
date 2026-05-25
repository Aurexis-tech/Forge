// Scaffold lookup. Codegen picks a scaffold by id; unknown ids fall back to
// the default with a warning surfaced in the plan-coverage report.

import {
  SCAFFOLD_FILES as AGENT_NODE_TOOL_USING_FILES,
  SCAFFOLD_TOOL_INTERFACE as AGENT_NODE_TOOL_USING_INTERFACE,
  type ScaffoldFile,
} from './agent-node-tool-using';

export const DEFAULT_SCAFFOLD_ID = 'agent-node-tool-using' as const;

interface ScaffoldDef {
  readonly id: string;
  readonly files: readonly ScaffoldFile[];
  readonly toolInterface: string;
}

const SCAFFOLDS: Record<string, ScaffoldDef> = {
  [DEFAULT_SCAFFOLD_ID]: {
    id: DEFAULT_SCAFFOLD_ID,
    files: AGENT_NODE_TOOL_USING_FILES,
    toolInterface: AGENT_NODE_TOOL_USING_INTERFACE,
  },
};

export interface ResolvedScaffold {
  readonly id: string;
  readonly requestedId: string;
  readonly files: readonly ScaffoldFile[];
  readonly toolInterface: string;
  readonly fellBack: boolean;
}

export function resolveScaffold(requestedId: string): ResolvedScaffold {
  const exact = SCAFFOLDS[requestedId];
  if (exact) {
    return {
      id: exact.id,
      requestedId,
      files: exact.files,
      toolInterface: exact.toolInterface,
      fellBack: false,
    };
  }
  const fallback = SCAFFOLDS[DEFAULT_SCAFFOLD_ID]!;
  return {
    id: fallback.id,
    requestedId,
    files: fallback.files,
    toolInterface: fallback.toolInterface,
    fellBack: true,
  };
}

export type { ScaffoldFile };
