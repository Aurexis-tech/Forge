import type { CostEvent } from '@/lib/types';

interface Props {
  events: CostEvent[];
}

const KIND_TONE: Record<string, string> = {
  llm: 'border-forge-amber/40 text-forge-amber',
  sandbox: 'border-forge-cyan/40 text-forge-cyan',
  runtime: 'border-emerald-400/40 text-emerald-300',
};

export function CostEventsTable({ events }: Props) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-forge-dim">
        No cost events recorded yet. Every LLM call, sandbox test, and
        runtime run lands here automatically.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <table className="w-full font-mono text-xs">
        <thead className="bg-black/40 text-forge-dim">
          <tr>
            <Th>when</Th>
            <Th>kind</Th>
            <Th>model</Th>
            <Th align="right">in</Th>
            <Th align="right">out</Th>
            <Th align="right">ms</Th>
            <Th align="right">USD</Th>
            <Th>ref</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-t border-white/5">
              <Td>{new Date(e.created_at).toLocaleString()}</Td>
              <Td>
                <span
                  className={
                    'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.25em] ' +
                    (KIND_TONE[e.kind] ?? 'border-white/15 text-forge-dim')
                  }
                >
                  {e.kind}
                </span>
              </Td>
              <Td>{e.model ?? '—'}</Td>
              <Td align="right">{e.input_tokens || ''}</Td>
              <Td align="right">{e.output_tokens || ''}</Td>
              <Td align="right">{e.compute_ms || ''}</Td>
              <Td align="right">${Number(e.amount_usd).toFixed(4)}</Td>
              <Td>
                <span className="text-forge-dim">{e.ref ?? ''}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={
        'px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] ' +
        (align === 'right' ? 'text-right' : 'text-left')
      }
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={
        'px-3 py-2 align-top text-forge-text/90 ' +
        (align === 'right' ? 'text-right tabular-nums' : 'text-left')
      }
    >
      {children}
    </td>
  );
}
