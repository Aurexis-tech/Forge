// Phase 2 (Systems) — agent-graph view.
//
// Renders an OrchestrationPlan as a node graph: nodes = sub-agents,
// edges = handoffs (with payload labels), laid out in topological
// order. This is how the user SEES the multi-agent structure instead
// of reading a list. Pure SVG so it works WebGL-off (the same path
// the 2D JourneyStepper takes when the 3D conduit is unavailable).
//
// Optional per-run overlay: when a `run` is passed, the view tints
// each node by per-run status — passed (the run walked through it
// cleanly), failed (the orchestrator's handoff validation threw at
// this node), pending (the run never reached it). The failing node
// is extracted from the run's stored logs (the [run] orchestrate_failed
// JSON line, same shape the executor emits in P2-5b).
//
// Brand tokens: obsidian background, amber for live/passed, cyan for
// pending/edge, rose for failed. No external graph library — a tiny
// hand-rolled topo layout keeps the dependency surface minimal and
// the render fully deterministic.

import type {
  OrchestrationPlan,
  OrchestrationNode,
} from '@/lib/engine/system/planner/schema';
import type { AgentRun } from '@/lib/types';

interface Props {
  plan: OrchestrationPlan;
  // Optional latest run row — when present, overlays per-node status
  // (passed / failed / pending) inferred from the run's outcome.
  run?: AgentRun | null;
  // Optional caption shown above the canvas. Defaults to a short
  // summary of the graph shape.
  caption?: string;
}

// ---------------------------------------------------------------------------
// Layout constants. All dimensions are in SVG user units; the outer
// <svg> uses viewBox so the layout scales responsively without
// changing relative positions.
// ---------------------------------------------------------------------------

const NODE_W = 180;
const NODE_H = 64;
const COL_GAP = 80; // horizontal space between layers
const ROW_GAP = 32; // vertical space between siblings in a layer
const MARGIN = 40; // outer margin around the graph

// ---------------------------------------------------------------------------
// Per-run status types. These are derived locally from the run row so
// the parent page doesn't have to know about graph internals.
// ---------------------------------------------------------------------------

export type NodeRunStatus =
  | 'passed' // The run completed this node successfully.
  | 'failed' // The run threw a handoff/orchestrator error at this node.
  | 'pending' // The run never reached this node (earlier failure).
  | 'idle'; // No run information available — show the node neutrally.

// ---------------------------------------------------------------------------
// Layout — topological level assignment + within-level row index.
// ---------------------------------------------------------------------------

interface LaidOutNode {
  node: OrchestrationNode;
  col: number;
  row: number;
  x: number;
  y: number;
}

interface Layout {
  nodes: LaidOutNode[];
  width: number;
  height: number;
}

function computeLayout(plan: OrchestrationPlan): Layout {
  // 1. Index nodes + collect incoming-edge map.
  const byId = new Map<string, OrchestrationNode>();
  for (const n of plan.nodes) byId.set(n.id, n);

  // depends_on per node: union of edge.from where edge.to===n.id PLUS
  // node.inputs[].from when not null. Either source counts.
  const upstream = new Map<string, Set<string>>();
  for (const n of plan.nodes) upstream.set(n.id, new Set());
  for (const e of plan.edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      upstream.get(e.to)!.add(e.from);
    }
  }
  for (const n of plan.nodes) {
    for (const h of n.inputs) {
      if (h.from !== null && byId.has(h.from)) {
        upstream.get(n.id)!.add(h.from);
      }
    }
  }

  // 2. Topological level assignment. Walk the plan's execution_order
  //    so cycles (already rejected by the planner schema) can't trip
  //    us up: level(n) = max(level(upstream(n))) + 1, or 0 if no
  //    upstream. Fallback: nodes not in execution_order get a level
  //    of 0 (shouldn't happen — schema enforces a permutation).
  const level = new Map<string, number>();
  for (const id of plan.execution_order) {
    const ups = upstream.get(id) ?? new Set();
    if (ups.size === 0) {
      level.set(id, 0);
      continue;
    }
    let maxUp = 0;
    for (const up of ups) {
      const upLevel = level.get(up);
      if (typeof upLevel === 'number' && upLevel + 1 > maxUp) {
        maxUp = upLevel + 1;
      }
    }
    level.set(id, maxUp);
  }
  // Any nodes not visited fall back to level 0.
  for (const n of plan.nodes) {
    if (!level.has(n.id)) level.set(n.id, 0);
  }

  // 3. Group by level, preserve declared order within a level.
  const byLevel = new Map<number, OrchestrationNode[]>();
  for (const n of plan.nodes) {
    const l = level.get(n.id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(n);
  }
  const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);
  const maxLevel = sortedLevels.length === 0 ? 0 : (sortedLevels[sortedLevels.length - 1] ?? 0);
  const maxRows = Math.max(
    1,
    ...Array.from(byLevel.values()).map((arr) => arr.length),
  );

  // 4. Centre each level vertically so a 1-node layer + a 3-node
  //    layer read visually balanced.
  const laid: LaidOutNode[] = [];
  for (const l of sortedLevels) {
    const nodes = byLevel.get(l) ?? [];
    const layerHeight = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
    const totalHeight = maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
    const yOffset = MARGIN + (totalHeight - layerHeight) / 2;
    nodes.forEach((node, row) => {
      laid.push({
        node,
        col: l,
        row,
        x: MARGIN + l * (NODE_W + COL_GAP),
        y: yOffset + row * (NODE_H + ROW_GAP),
      });
    });
  }

  const width = MARGIN * 2 + (maxLevel + 1) * NODE_W + maxLevel * COL_GAP;
  const height = MARGIN * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  return { nodes: laid, width, height };
}

// ---------------------------------------------------------------------------
// Per-run status inference. Reads the run row's `logs` field — when
// the executor emits [run] orchestrate_failed {"node":"..."} on a
// handoff failure, we capture that node id and label it 'failed',
// everything BEFORE it 'passed', everything AFTER 'pending'. A
// passed run labels every node 'passed'. No run → 'idle' everywhere.
// ---------------------------------------------------------------------------

export function deriveNodeRunStatuses(
  plan: OrchestrationPlan,
  run: AgentRun | null | undefined,
): Map<string, NodeRunStatus> {
  const out = new Map<string, NodeRunStatus>();
  if (!run) {
    for (const n of plan.nodes) out.set(n.id, 'idle');
    return out;
  }
  if (run.status === 'succeeded') {
    for (const n of plan.nodes) out.set(n.id, 'passed');
    return out;
  }
  if (run.status === 'running') {
    // Mid-flight — we don't know the cursor; mark every node 'pending'.
    for (const n of plan.nodes) out.set(n.id, 'pending');
    return out;
  }

  // Failed (or any other terminal non-success). Try to find the
  // failing node from the structured driver log line.
  const failingNode = extractFailingNode(run);
  const order = plan.execution_order;
  const failIdx = failingNode ? order.indexOf(failingNode) : -1;

  if (failIdx < 0) {
    // No structured failure marker — mark every node 'pending' so the
    // graph reads as "ran but state unknown" rather than fabricating
    // pass/fail.
    for (const n of plan.nodes) out.set(n.id, 'pending');
    return out;
  }

  order.forEach((id, i) => {
    if (i < failIdx) out.set(id, 'passed');
    else if (i === failIdx) out.set(id, 'failed');
    else out.set(id, 'pending');
  });
  // Any node not in execution_order (shouldn't happen by schema) gets
  // a neutral status so the render doesn't break.
  for (const n of plan.nodes) {
    if (!out.has(n.id)) out.set(n.id, 'idle');
  }
  return out;
}

interface LogLineLite {
  message?: unknown;
}

function extractFailingNode(run: AgentRun): string | null {
  // The executor's logs are a JSON array of { stream, message, at }
  // entries. We scan from the end backwards — the most recent
  // [run] orchestrate_failed line is the one that triggered the
  // run-row's failed status.
  const rawLogs = run.logs;
  if (!Array.isArray(rawLogs)) return null;
  const logs = rawLogs as unknown as LogLineLite[];
  const marker = '[run] orchestrate_failed ';
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (!entry || typeof entry.message !== 'string') continue;
    const at = entry.message.indexOf(marker);
    if (at < 0) continue;
    const jsonStr = entry.message.slice(at + marker.length).trim();
    try {
      const parsed = JSON.parse(jsonStr) as { node?: unknown };
      if (typeof parsed.node === 'string') return parsed.node;
    } catch {
      // keep scanning
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render. Pure SVG so the graph is fully usable when WebGL is off.
// ---------------------------------------------------------------------------

const NODE_TONE: Record<NodeRunStatus, { fill: string; stroke: string; text: string; label: string }> = {
  passed: {
    fill: 'rgba(245, 158, 11, 0.18)', // amber-500/18
    stroke: 'rgba(245, 158, 11, 0.85)',
    text: '#fbbf24',
    label: 'rgba(251, 191, 36, 0.85)',
  },
  failed: {
    fill: 'rgba(244, 63, 94, 0.18)', // rose-500/18
    stroke: 'rgba(244, 63, 94, 0.85)',
    text: '#fda4af',
    label: 'rgba(253, 164, 175, 0.85)',
  },
  pending: {
    fill: 'rgba(255, 255, 255, 0.04)',
    stroke: 'rgba(255, 255, 255, 0.18)',
    text: 'rgba(255, 255, 255, 0.6)',
    label: 'rgba(255, 255, 255, 0.5)',
  },
  idle: {
    fill: 'rgba(34, 211, 238, 0.08)', // forge-cyan/8
    stroke: 'rgba(34, 211, 238, 0.45)',
    text: 'rgba(255, 255, 255, 0.92)',
    label: 'rgba(34, 211, 238, 0.85)',
  },
};

export function SystemGraphView({ plan, run, caption }: Props) {
  const layout = computeLayout(plan);
  const statuses = deriveNodeRunStatuses(plan, run);
  const nodeById = new Map(layout.nodes.map((n) => [n.node.id, n]));

  const captionText =
    caption ??
    plan.nodes.length +
      ' agent' +
      (plan.nodes.length === 1 ? '' : 's') +
      ' · ' +
      plan.edges.length +
      ' handoff' +
      (plan.edges.length === 1 ? '' : 's') +
      ' · pattern · ' +
      plan.pattern +
      (run ? ' · last run · ' + run.status : '');

  return (
    <figure
      className="rounded-2xl border border-white/10 bg-black/30 p-4"
      aria-label="System agent graph"
    >
      <figcaption className="mb-3 font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
        {captionText}
      </figcaption>
      <div className="w-full overflow-x-auto">
        <svg
          role="img"
          aria-label="Agent graph showing nodes and handoffs in topological order"
          viewBox={'0 0 ' + layout.width + ' ' + layout.height}
          width="100%"
          // Cap the rendered height so a wide graph compresses
          // horizontally rather than ballooning vertically.
          style={{
            maxHeight: '420px',
            display: 'block',
            background:
              'radial-gradient(circle at 50% 0%, rgba(34,211,238,0.05), transparent 70%)',
          }}
        >
          {/* Arrow-head marker shared across edges. */}
          <defs>
            <marker
              id="forge-graph-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(34, 211, 238, 0.65)" />
            </marker>
            <marker
              id="forge-graph-arrow-passed"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(245, 158, 11, 0.9)" />
            </marker>
          </defs>

          {/* Edges first, so nodes layer on top. */}
          {plan.edges.map((edge, i) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            // Edge endpoints: right edge of source → left edge of target.
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            // Bezier control points for a gentle horizontal curve.
            const cx = (x1 + x2) / 2;
            const path =
              'M ' +
              x1 +
              ' ' +
              y1 +
              ' C ' +
              cx +
              ' ' +
              y1 +
              ', ' +
              cx +
              ' ' +
              y2 +
              ', ' +
              x2 +
              ' ' +
              y2;
            // Tint edge by upstream node's status — if both endpoints
            // passed, the edge "carried" data → amber. Otherwise cyan.
            const fromStatus = statuses.get(edge.from);
            const toStatus = statuses.get(edge.to);
            const edgePassed = fromStatus === 'passed' && toStatus === 'passed';
            const stroke = edgePassed
              ? 'rgba(245, 158, 11, 0.7)'
              : fromStatus === 'failed' || toStatus === 'failed'
                ? 'rgba(244, 63, 94, 0.6)'
                : 'rgba(34, 211, 238, 0.4)';
            const arrowId = edgePassed
              ? 'forge-graph-arrow-passed'
              : 'forge-graph-arrow';
            // Label placement: midpoint of the curve, offset slightly.
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2 - 8;
            return (
              <g key={'edge-' + i}>
                <path
                  d={path}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={1.6}
                  markerEnd={'url(#' + arrowId + ')'}
                />
                {edge.payload ? (
                  <text
                    x={mx}
                    y={my}
                    textAnchor="middle"
                    fontSize={10}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    fill="rgba(255, 255, 255, 0.55)"
                  >
                    {edge.payload.length > 32
                      ? edge.payload.slice(0, 31) + '…'
                      : edge.payload}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* Nodes. */}
          {layout.nodes.map((laid) => {
            const status = statuses.get(laid.node.id) ?? 'idle';
            const tone = NODE_TONE[status];
            return (
              <g
                key={'node-' + laid.node.id}
                transform={'translate(' + laid.x + ' ' + laid.y + ')'}
              >
                <rect
                  x={0}
                  y={0}
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  ry={10}
                  fill={tone.fill}
                  stroke={tone.stroke}
                  strokeWidth={1.4}
                />
                <text
                  x={12}
                  y={22}
                  fontSize={11}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fontWeight={500}
                  fill={tone.text}
                >
                  {laid.node.id}
                </text>
                <text
                  x={12}
                  y={40}
                  fontSize={10}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fill={tone.label}
                >
                  {laid.node.role.length > 24
                    ? laid.node.role.slice(0, 23) + '…'
                    : laid.node.role}
                </text>
                <text
                  x={12}
                  y={56}
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fill="rgba(255, 255, 255, 0.4)"
                  letterSpacing={1.4}
                >
                  {status.toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Legend run={run} />
    </figure>
  );
}

function Legend({ run }: { run: AgentRun | null | undefined }) {
  if (!run) {
    return (
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        no run yet · graph shows the plan only
      </p>
    );
  }
  const chips: Array<{ key: NodeRunStatus; label: string }> = [
    { key: 'passed', label: 'passed' },
    { key: 'failed', label: 'failed' },
    { key: 'pending', label: 'pending' },
  ];
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-2">
      {chips.map(({ key, label }) => {
        const t = NODE_TONE[key];
        return (
          <li
            key={key}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.3em]"
            style={{ color: t.text }}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: t.stroke }}
            />
            {label}
          </li>
        );
      })}
      <li className="ml-auto font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        run · {run.status}
      </li>
    </ul>
  );
}
