// Layered DAG visualisation of the planner's tasks. Pure presentational —
// the heavy validation (uniqueness, references, cycles) happens before this
// component ever sees the data, so it can assume a clean graph.

import type { PlanTask } from '@/lib/engine/planner/schema';

interface LayeredTask {
  task: PlanTask;
  layer: number;
}

function computeLayers(tasks: readonly PlanTask[]): LayeredTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();

  function layerOf(id: string, stack: Set<string>): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0; // defensive — graph is validated upstream
    const task = byId.get(id);
    if (!task) return 0;
    stack.add(id);
    let max = 0;
    for (const dep of task.depends_on) {
      if (!byId.has(dep) || dep === id) continue;
      max = Math.max(max, layerOf(dep, stack) + 1);
    }
    stack.delete(id);
    memo.set(id, max);
    return max;
  }

  return tasks.map((task) => ({ task, layer: layerOf(task.id, new Set()) }));
}

function groupByLayer(layered: LayeredTask[]): LayeredTask[][] {
  if (layered.length === 0) return [];
  const maxLayer = layered.reduce((m, t) => Math.max(m, t.layer), 0);
  const layers: LayeredTask[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const lt of layered) layers[lt.layer]!.push(lt);
  return layers;
}

export function TaskGraph({ tasks }: { tasks: readonly PlanTask[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-forge-dim">
        No build tasks declared.
      </p>
    );
  }

  const layers = groupByLayer(computeLayers(tasks));
  const knownIds = new Set(tasks.map((t) => t.id));

  return (
    <div className="flex flex-col gap-3">
      {layers.map((layer, idx) => (
        <div key={idx} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
              phase {idx + 1}
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-forge-cyan/40 to-transparent" />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {layer.map(({ task }) => (
              <TaskCard key={task.id} task={task} knownIds={knownIds} />
            ))}
          </div>
          {idx < layers.length - 1 ? (
            <div
              aria-hidden
              className="mx-auto h-3 w-px bg-gradient-to-b from-forge-amber/60 to-transparent"
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  knownIds,
}: {
  task: PlanTask;
  knownIds: ReadonlySet<string>;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <code className="font-mono text-[11px] text-forge-amber">{task.id}</code>
        {task.depends_on.length === 0 ? (
          <span className="rounded-full border border-forge-cyan/30 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] text-forge-cyan/80">
            root
          </span>
        ) : null}
      </div>
      <p className="text-sm font-medium text-forge-text">{task.title}</p>
      <p className="text-xs leading-relaxed text-forge-dim">{task.description}</p>
      {task.depends_on.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-forge-dim">
            depends on
          </span>
          {task.depends_on.map((dep) => (
            <span
              key={dep}
              className={
                'rounded-full border px-2 py-0.5 font-mono text-[10px] ' +
                (knownIds.has(dep)
                  ? 'border-white/15 text-forge-text/80'
                  : 'border-rose-400/50 text-rose-300')
              }
            >
              {dep}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
