'use client';

// Read-only file explorer for a generated build. Two columns: a file tree
// on the left, a syntax-highlighted file viewer on the right.

import { useMemo, useState } from 'react';
import { FileTree, type FileMeta, type StaticStatus } from './FileTree';
import { HighlightedCode } from './HighlightedCode';
import type { BuildFile } from '@/lib/types';

interface StaticCheckEntry {
  path: string;
  status: StaticStatus;
  error?: string;
}

interface Props {
  files: BuildFile[];
  staticChecks: StaticCheckEntry[];
  warnings: string[];
}

export function BuildView({ files, staticChecks, warnings }: Props) {
  const metas = useMemo(() => {
    const map = new Map<string, FileMeta>();
    const checkByPath = new Map(staticChecks.map((c) => [c.path, c]));
    for (const f of files) {
      const entry = checkByPath.get(f.path);
      map.set(f.path, {
        source: f.source,
        static: entry?.status ?? 'skipped',
      });
    }
    return map;
  }, [files, staticChecks]);

  const initialPath = useMemo(() => {
    // Prefer the entrypoint-ish first generated file, else the first file.
    const generated = files.find((f) => f.source === 'generated');
    return (generated ?? files[0])?.path ?? null;
  }, [files]);

  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const selected = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const selectedCheck = useMemo(
    () => staticChecks.find((c) => c.path === selectedPath) ?? null,
    [staticChecks, selectedPath],
  );

  const failedCount = staticChecks.filter((c) => c.status === 'failed').length;

  return (
    <div className="flex flex-col gap-4">
      {warnings.length > 0 ? (
        <WarningsBanner warnings={warnings} failedCount={failedCount} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <aside className="rounded-xl border border-white/10 bg-black/30 p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              files · {files.length}
            </h3>
            <Legend />
          </div>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <FileTree
              files={files}
              metas={metas}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          </div>
        </aside>

        <section className="flex flex-col rounded-xl border border-white/10 bg-black/40">
          {selected ? (
            <>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-2">
                <code className="font-mono text-xs text-forge-text">
                  {selected.path}
                </code>
                <div className="flex items-center gap-2">
                  <SourcePill source={selected.source} />
                  <CheckPill status={selectedCheck?.status ?? 'skipped'} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
                    {selected.bytes} B
                  </span>
                </div>
              </header>
              {selectedCheck && selectedCheck.status === 'failed' ? (
                <div className="border-b border-rose-400/30 bg-rose-500/[0.08] px-4 py-2">
                  <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
                    static check failed
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-rose-200/90">
                    {selectedCheck.error ?? 'unknown error'}
                  </pre>
                </div>
              ) : null}
              <div className="max-h-[60vh] overflow-y-auto p-4">
                <HighlightedCode path={selected.path} content={selected.content} />
              </div>
            </>
          ) : (
            <div className="p-6 text-sm text-forge-dim">
              Select a file to preview its contents.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WarningsBanner({
  warnings,
  failedCount,
}: {
  warnings: string[];
  failedCount: number;
}) {
  return (
    <div className="rounded-xl border border-amber-400/50 bg-amber-500/[0.07] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-amber-300">
        codegen warnings{failedCount > 0 ? ' · ' + failedCount + ' file(s) failed parse' : ''}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-amber-100/90">
        {warnings.map((w, i) => (
          <li key={i} className="flex gap-2">
            <span
              aria-hidden
              className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-300"
            />
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-forge-dim">
      <span className="flex items-center gap-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        ok
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400" />
        fail
      </span>
    </div>
  );
}

function SourcePill({ source }: { source: BuildFile['source'] }) {
  const tone =
    source === 'scaffold'
      ? 'border-forge-cyan/40 text-forge-cyan'
      : 'border-forge-amber/50 text-forge-amber';
  return (
    <span
      className={
        'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
        tone
      }
    >
      {source}
    </span>
  );
}

function CheckPill({ status }: { status: StaticStatus }) {
  const tone =
    status === 'ok'
      ? 'border-emerald-400/40 text-emerald-300'
      : status === 'failed'
        ? 'border-rose-400/50 text-rose-300'
        : 'border-white/15 text-forge-dim';
  return (
    <span
      className={
        'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
        tone
      }
    >
      static · {status}
    </span>
  );
}
