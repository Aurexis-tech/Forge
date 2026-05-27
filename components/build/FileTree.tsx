'use client';

// Collapsible file tree for the build preview. Each leaf shows source +
// static-check badges so the user sees the state of the build at a glance.

import { useMemo, useState } from 'react';
import type { BuildFile, BuildFileSource } from '@/lib/types';

export type StaticStatus = 'ok' | 'failed' | 'skipped';

export interface FileMeta {
  source: BuildFileSource;
  static: StaticStatus;
}

interface DirNode {
  type: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  type: 'file';
  name: string;
  path: string;
  meta: FileMeta;
}
type TreeNode = DirNode | FileNode;

function buildTree(files: BuildFile[], metas: Map<string, FileMeta>): DirNode {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] };

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let cursor: DirNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      const fullPath = parts.slice(0, i + 1).join('/');
      let dir = cursor.children.find(
        (c): c is DirNode => c.type === 'dir' && c.name === segment,
      );
      if (!dir) {
        dir = { type: 'dir', name: segment, path: fullPath, children: [] };
        cursor.children.push(dir);
      }
      cursor = dir;
    }
    const leafName = parts[parts.length - 1] ?? f.path;
    const meta: FileMeta = metas.get(f.path) ?? {
      source: f.source,
      static: 'skipped',
    };
    cursor.children.push({
      type: 'file',
      name: leafName,
      path: f.path,
      meta,
    });
  }

  sortNode(root);
  return root;
}

function sortNode(node: DirNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) {
    if (c.type === 'dir') sortNode(c);
  }
}

interface FileTreeProps {
  files: BuildFile[];
  metas: Map<string, FileMeta>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function FileTree({ files, metas, selectedPath, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files, metas), [files, metas]);
  return (
    <div className="font-mono text-xs">
      <NodeView
        node={tree}
        depth={0}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    </div>
  );
}

function NodeView({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.type === 'dir') {
    // Hidden root: render its children flush.
    if (node.path === '') {
      return (
        <ul className="flex flex-col">
          {node.children.map((c) => (
            <li key={c.path || c.name}>
              <NodeView
                node={c}
                depth={depth}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      );
    }
    return <DirView node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />;
  }
  return (
    <FileView
      node={node}
      depth={depth}
      isSelected={selectedPath === node.path}
      onSelect={onSelect}
    />
  );
}

function DirView({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: DirNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const pad = { paddingLeft: depth * 12 + 'px' };
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pad}
        className="flex w-full items-center gap-1.5 py-1 text-left text-forge-text/80 hover:text-forge-text"
      >
        <span
          aria-hidden
          className={
            'inline-block w-2 text-forge-dim transition ' +
            (open ? 'rotate-90' : '')
          }
        >
          ▸
        </span>
        <span className="truncate text-forge-cyan">{node.name}</span>
      </button>
      {open ? (
        <ul className="flex flex-col">
          {node.children.map((c) => (
            <li key={c.path || c.name}>
              <NodeView
                node={c}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FileView({
  node,
  depth,
  isSelected,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  isSelected: boolean;
  onSelect: (path: string) => void;
}) {
  const pad = { paddingLeft: depth * 12 + 12 + 'px' };
  const baseTone = isSelected
    ? 'bg-forge-amber/10 text-forge-text'
    : 'text-forge-text/80 hover:text-forge-text';
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={pad}
      className={
        'flex w-full items-center justify-between gap-2 rounded py-1 pr-2 text-left transition ' +
        baseTone
      }
    >
      <span className="flex items-center gap-1.5 truncate">
        <StatusDot status={node.meta.static} />
        <span className="truncate">{node.name}</span>
      </span>
      <SourceTag source={node.meta.source} />
    </button>
  );
}

function StatusDot({ status }: { status: StaticStatus }) {
  const tone =
    status === 'ok'
      ? 'bg-emerald-400'
      : status === 'failed'
        ? 'bg-rose-400'
        : 'bg-forge-dim';
  return (
    <span
      aria-label={'static check ' + status}
      className={'inline-block h-1.5 w-1.5 rounded-full ' + tone}
    />
  );
}

function SourceTag({ source }: { source: BuildFileSource }) {
  const tone =
    source === 'scaffold'
      ? 'border-forge-cyan/30 text-forge-cyan/90'
      : 'border-forge-amber/40 text-forge-amber';
  return (
    <span
      className={
        'rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.15em] ' +
        tone
      }
    >
      {source === 'scaffold' ? 'scaf' : 'gen'}
    </span>
  );
}
