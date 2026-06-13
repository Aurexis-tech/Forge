// Aurexis Forge — Capability Upgrade #4, gap 2: the DB-PROVISION SCHEMA DIFF.
//
// Surfaces EXACTLY what a provision will do to a database — new tables,
// additive columns (safe), and DESTRUCTIVE changes (drops + lossy type
// changes) — and forces a typed confirmation before any destructive migration
// runs. The provision gate already requires {authorized:true}; this adds a
// second, narrower barrier so a user can't authorize away a column/table drop
// (or a lossy type change) without typing the database name to confirm.
//
// FAIL-CLOSED on ambiguity: a type change is destructive ('narrow_type')
// UNLESS it is a KNOWN-SAFE widening. Unknown-vs-unknown → destructive. Better
// to over-prompt than to silently drop data with a confirmed-looking migration.

export interface Column {
  readonly name: string;
  readonly type: string;
}

export interface Table {
  readonly name: string;
  readonly columns: ReadonlyArray<Column>;
}

export type DestructiveChange =
  | { readonly kind: 'drop_table'; readonly table: string }
  | { readonly kind: 'drop_column'; readonly table: string; readonly column: string }
  | {
      readonly kind: 'narrow_type';
      readonly table: string;
      readonly column: string;
      readonly from: string;
      readonly to: string;
    };

export interface SchemaDiff {
  // Tables present in `planned` but not `current`.
  readonly createTables: Table[];
  // Columns added to an existing table (additive — non-destructive).
  readonly addColumns: { table: string; column: Column }[];
  // KNOWN-SAFE type widenings on existing columns (non-destructive).
  readonly widenColumns: {
    table: string;
    column: string;
    from: string;
    to: string;
  }[];
  // Drops + lossy/ambiguous type changes — require a typed confirm.
  readonly destructive: DestructiveChange[];
}

// ---------------------------------------------------------------------------
// Type comparison. Conservative: only a small set of widenings is "safe"; any
// other change (including unknown types) is treated as a narrowing.
// ---------------------------------------------------------------------------

function normalizeType(t: string): string {
  // Lowercase, strip a (n) / (p,s) parameter, collapse whitespace.
  return t
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// from → set of `to` types that are loss-LESS widenings of `from`.
const SAFE_WIDENINGS: Record<string, ReadonlySet<string>> = {
  smallint: new Set(['integer', 'int', 'int4', 'bigint', 'int8', 'numeric', 'decimal']),
  int2: new Set(['integer', 'int', 'int4', 'bigint', 'int8', 'numeric', 'decimal']),
  integer: new Set(['bigint', 'int8', 'numeric', 'decimal']),
  int: new Set(['bigint', 'int8', 'numeric', 'decimal']),
  int4: new Set(['bigint', 'int8', 'numeric', 'decimal']),
  real: new Set(['double precision', 'float8']),
  float4: new Set(['double precision', 'float8']),
  varchar: new Set(['text']),
  'character varying': new Set(['text']),
};

function isSafeWiden(from: string, to: string): boolean {
  const f = normalizeType(from);
  const t = normalizeType(to);
  if (f === t) return true; // no change
  return SAFE_WIDENINGS[f]?.has(t) ?? false;
}

// ---------------------------------------------------------------------------
// The diff.
// ---------------------------------------------------------------------------

export function buildSchemaDiff(
  current: ReadonlyArray<Table>,
  planned: ReadonlyArray<Table>,
): SchemaDiff {
  const curByName = new Map(current.map((t) => [t.name, t]));
  const planByName = new Map(planned.map((t) => [t.name, t]));

  const createTables: Table[] = [];
  const addColumns: { table: string; column: Column }[] = [];
  const widenColumns: { table: string; column: string; from: string; to: string }[] = [];
  const destructive: DestructiveChange[] = [];

  // New tables (planned ∖ current).
  for (const p of planned) {
    if (!curByName.has(p.name)) createTables.push(p);
  }
  // Dropped tables (current ∖ planned) — destructive.
  for (const c of current) {
    if (!planByName.has(c.name)) {
      destructive.push({ kind: 'drop_table', table: c.name });
    }
  }
  // Column-level diff for tables present in BOTH.
  for (const p of planned) {
    const c = curByName.get(p.name);
    if (!c) continue;
    const curCols = new Map(c.columns.map((col) => [col.name, col]));
    const planCols = new Map(p.columns.map((col) => [col.name, col]));

    // Added columns (additive).
    for (const col of p.columns) {
      if (!curCols.has(col.name)) addColumns.push({ table: p.name, column: col });
    }
    // Dropped columns + type changes.
    for (const col of c.columns) {
      const pc = planCols.get(col.name);
      if (!pc) {
        destructive.push({ kind: 'drop_column', table: p.name, column: col.name });
        continue;
      }
      if (normalizeType(pc.type) !== normalizeType(col.type)) {
        if (isSafeWiden(col.type, pc.type)) {
          widenColumns.push({ table: p.name, column: col.name, from: col.type, to: pc.type });
        } else {
          destructive.push({
            kind: 'narrow_type',
            table: p.name,
            column: col.name,
            from: col.type,
            to: pc.type,
          });
        }
      }
    }
  }

  return { createTables, addColumns, widenColumns, destructive };
}

// ---------------------------------------------------------------------------
// The provision prompt — what the gate UI renders + what applyDbProvision
// enforces. A destructive diff requires a typed confirmation equal to the
// database name.
// ---------------------------------------------------------------------------

export interface DbProvisionPrompt {
  readonly dbName: string;
  readonly diff: SchemaDiff;
  // True iff the diff has ANY destructive change → typed confirm required.
  readonly requiresTypedConfirm: boolean;
  // The exact string the user must type to confirm a destructive provision.
  readonly confirmPhrase: string;
  // Human-readable one-liner for the gate UI + audit.
  readonly summary: string;
}

export function buildDbProvisionPrompt(
  current: ReadonlyArray<Table>,
  planned: ReadonlyArray<Table>,
  dbName: string,
): DbProvisionPrompt {
  const diff = buildSchemaDiff(current, planned);
  return {
    dbName,
    diff,
    requiresTypedConfirm: diff.destructive.length > 0,
    confirmPhrase: dbName,
    summary: summarizeDiff(diff),
  };
}

function summarizeDiff(diff: SchemaDiff): string {
  const parts: string[] = [];
  if (diff.createTables.length) parts.push(diff.createTables.length + ' new table(s)');
  if (diff.addColumns.length) parts.push(diff.addColumns.length + ' new column(s)');
  if (diff.widenColumns.length) parts.push(diff.widenColumns.length + ' safe type widening(s)');
  if (diff.destructive.length) {
    const drops = diff.destructive.filter((d) => d.kind !== 'narrow_type').length;
    const narrows = diff.destructive.filter((d) => d.kind === 'narrow_type').length;
    const bits: string[] = [];
    if (drops) bits.push(drops + ' drop(s)');
    if (narrows) bits.push(narrows + ' lossy type change(s)');
    parts.push('DESTRUCTIVE: ' + bits.join(' + '));
  }
  return parts.length ? parts.join(', ') : 'no schema changes';
}

// Thrown when a provision is refused by the gate.
export class ProvisionBlocked extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? 'provision blocked: ' + reason);
    this.name = 'ProvisionBlocked';
    this.reason = reason;
  }
}

// The provision choke-point. Requires explicit authorization ALWAYS, and a
// correct typed confirmation when the diff is destructive. Only then does the
// side-effecting `migrate` run.
export async function applyDbProvision(opts: {
  prompt: DbProvisionPrompt;
  authorized: boolean;
  typedConfirm?: string;
  migrate: () => Promise<void>;
}): Promise<void> {
  if (!opts.authorized) {
    throw new ProvisionBlocked('not_authorized');
  }
  if (opts.prompt.requiresTypedConfirm) {
    if (!opts.typedConfirm || opts.typedConfirm !== opts.prompt.confirmPhrase) {
      throw new ProvisionBlocked('typed_confirm_required');
    }
  }
  await opts.migrate();
}
