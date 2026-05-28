// The 'standard' baseline coordination pattern.
//
// Its expand() DELEGATES to the existing deriveGraph — it does NOT
// reimplement the orchestration build. So a system without an explicit
// coordination_pattern (resolving to 'standard') produces a
// byte-identical graph to the pre-catalog code path. The catalog
// becomes the single dispatch point with zero behavioural risk.

import { deriveGraph } from '../planner/graph';
import type { CoordinationPatternDef } from './types';

export const STANDARD: CoordinationPatternDef = {
  id: 'standard',
  label: 'Standard',
  description:
    'Baseline pattern: wire the declared sub_agents into handoffs using ' +
    'coordination.pattern (pipeline / fan_out_in / dag). Byte-identical to ' +
    'the pre-catalog behaviour — this wraps the existing code path.',
  node_roles: [],
  expand: (spec) => deriveGraph(spec),
};
