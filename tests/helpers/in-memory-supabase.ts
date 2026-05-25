// In-memory Supabase test double.
//
// Implements the SUBSET of the @supabase/supabase-js fluent builder that
// the Aurexis Forge engine actually uses. Tests can seed rows directly
// via `db.tables.<name>` and then exercise production code paths that
// expect a real client.
//
// What's supported:
//   .from(table).select(cols).eq(col, v).maybeSingle()
//   .from(table).select(cols).eq(col, v).order(col, opts).limit(n)
//   .from(table).select(cols).in(col, arr)
//   .from(table).select(cols).gte(col, v)
//   .from(table).select(cols).is(col, null)
//   .from(table).select(cols).filter(col, op, v)
//   .from(table).insert(row|rows).select(cols).single()
//   .from(table).update(patch).eq(col, v)[.eq().is()].select(cols).single?
//   .from(table).upsert(row, { onConflict }).select(cols).single()
//   .from(table).delete().eq(col, v)
//
// Anything else returns { data: null, error: 'unsupported' } so a
// regression in the production code that adds a new query shape is loud
// in the tests rather than silent.
//
// NOT supported (intentional): RLS, auth, real types beyond JSON-shape
// objects, joins, rpc. Tests construct rows literally.

export type Row = Record<string, unknown>;

export interface InMemoryDb {
  tables: Record<string, Row[]>;
  // Fail-injection hook used by the governance fail-closed test —
  // when set, every .select() throws so we can prove the guard
  // refuses to allow the action on an unreadable state.
  forceReadError: Error | null;
  // Auto-generate UUID-shaped ids for inserts that omit `id`.
  nextId: number;
}

export function createInMemoryDb(): InMemoryDb {
  return {
    tables: {},
    forceReadError: null,
    nextId: 1,
  };
}

function uuidish(n: number): string {
  // 36-char fake-UUID — deterministic, satisfies the `^[0-9a-fA-F-]{36}$`
  // regex used in 0009_governance.sql.
  const pad = n.toString(16).padStart(12, '0');
  return '00000000-0000-4000-8000-' + pad;
}

interface Filter {
  kind: 'eq' | 'in' | 'gte' | 'is' | 'filter';
  col: string;
  // For eq/gte/is: a single value. For 'in': an array. For 'filter':
  // [op, value].
  value: unknown;
}

interface OrderSpec {
  col: string;
  ascending: boolean;
}

type QueryResult<T> = Promise<{ data: T; error: { message: string } | null }>;

class QueryBuilder {
  private filters: Filter[] = [];
  private orderSpec: OrderSpec | null = null;
  private limitN: number | null = null;
  // After .insert() / .update() / .upsert() / .delete() this carries the
  // operation and (for write ops) the payload.
  private op:
    | { kind: 'select'; cols: string }
    | { kind: 'insert'; rows: Row[] }
    | { kind: 'update'; patch: Row }
    | { kind: 'upsert'; rows: Row[]; onConflict: string[] }
    | { kind: 'delete' };
  // Optional .select() chained after a write op — controls the return shape.
  private postSelect: string | null = null;

  constructor(
    private db: InMemoryDb,
    private table: string,
    initial: QueryBuilder['op'] = { kind: 'select', cols: '*' },
  ) {
    this.op = initial;
  }

  select(cols = '*'): QueryBuilder {
    if (this.op.kind === 'select') {
      this.op = { kind: 'select', cols };
    } else {
      this.postSelect = cols;
    }
    return this;
  }

  eq(col: string, value: unknown): QueryBuilder {
    this.filters.push({ kind: 'eq', col, value });
    return this;
  }
  in(col: string, value: unknown[]): QueryBuilder {
    this.filters.push({ kind: 'in', col, value });
    return this;
  }
  gte(col: string, value: unknown): QueryBuilder {
    this.filters.push({ kind: 'gte', col, value });
    return this;
  }
  is(col: string, value: unknown): QueryBuilder {
    this.filters.push({ kind: 'is', col, value });
    return this;
  }
  filter(col: string, op: string, value: unknown): QueryBuilder {
    this.filters.push({ kind: 'filter', col, value: [op, value] });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder {
    this.orderSpec = { col, ascending: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): QueryBuilder {
    this.limitN = n;
    return this;
  }

  // --- Write ops --------------------------------------------------------

  insert(rowOrRows: Row | Row[]): QueryBuilder {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    this.op = { kind: 'insert', rows };
    return this;
  }
  update(patch: Row): QueryBuilder {
    this.op = { kind: 'update', patch };
    return this;
  }
  upsert(
    rowOrRows: Row | Row[],
    opts: { onConflict?: string } = {},
  ): QueryBuilder {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const onConflict = (opts.onConflict ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.op = { kind: 'upsert', rows, onConflict };
    return this;
  }
  delete(): QueryBuilder {
    this.op = { kind: 'delete' };
    return this;
  }

  // --- Terminals --------------------------------------------------------

  // Acts as the awaitable terminator for select/update/delete without
  // .single()/.maybeSingle() — Supabase returns { data: T[], error }.
  // Cast the promise to `any` at the boundary: TS strict-mode can't
  // narrow the chained generic without redundant type plumbing, and
  // the surface is the supabase shape callers already destructure as
  // `{ data, error }`.
  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: Row[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }

  async maybeSingle(): QueryResult<Row | null> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    const list = data as Row[];
    if (list.length === 0) return { data: null, error: null };
    return { data: list[0] ?? null, error: null };
  }

  async single(): QueryResult<Row | null> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    const list = data as Row[];
    if (list.length !== 1) {
      return {
        data: null,
        error: { message: 'expected single row, got ' + list.length },
      };
    }
    return { data: list[0] ?? null, error: null };
  }

  // --- Execution -------------------------------------------------------

  private async run(): QueryResult<Row[]> {
    if (this.db.forceReadError) {
      // Hit the same shape Supabase emits on a failure — production code
      // checks `error` on every call.
      return {
        data: [],
        error: { message: this.db.forceReadError.message },
      };
    }
    // Lazily create the table bucket. The local `t` reference is the
    // narrowed-to-non-undefined handle TS needs inside each case below;
    // mutations on it go straight to the live DB array via shared
    // reference.
    let t = this.db.tables[this.table];
    if (!t) {
      t = [];
      this.db.tables[this.table] = t;
    }

    switch (this.op.kind) {
      case 'select': {
        let rows = t.filter((r) => this.matches(r));
        if (this.orderSpec) {
          const { col, ascending } = this.orderSpec;
          rows = [...rows].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return ascending ? -1 : 1;
            if (bv == null) return ascending ? 1 : -1;
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
            return 0;
          });
        }
        if (this.limitN != null) rows = rows.slice(0, this.limitN);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }

      case 'insert': {
        const inserted: Row[] = [];
        for (const r of this.op.rows) {
          const row: Row = {
            id: typeof r.id === 'string' ? r.id : uuidish(this.db.nextId++),
            created_at:
              typeof r.created_at === 'string'
                ? r.created_at
                : new Date().toISOString(),
            updated_at:
              typeof r.updated_at === 'string'
                ? r.updated_at
                : new Date().toISOString(),
            ...r,
          };
          t.push(row);
          inserted.push({ ...row });
        }
        if (this.postSelect != null) {
          return { data: inserted, error: null };
        }
        return { data: inserted, error: null };
      }

      case 'update': {
        const patch = this.op.patch;
        const updated: Row[] = [];
        for (const r of t) {
          if (!this.matches(r)) continue;
          Object.assign(r, patch, { updated_at: new Date().toISOString() });
          updated.push({ ...r });
        }
        return { data: updated, error: null };
      }

      case 'upsert': {
        const conflictKeys = this.op.onConflict;
        const upserted: Row[] = [];
        for (const r of this.op.rows) {
          let existing: Row | undefined;
          if (conflictKeys.length > 0) {
            existing = t.find((row) =>
              conflictKeys.every((k) => row[k] === r[k]),
            );
          }
          if (existing) {
            Object.assign(existing, r, {
              updated_at: new Date().toISOString(),
            });
            upserted.push({ ...existing });
          } else {
            const fresh: Row = {
              id: typeof r.id === 'string' ? r.id : uuidish(this.db.nextId++),
              created_at:
                typeof r.created_at === 'string'
                  ? r.created_at
                  : new Date().toISOString(),
              updated_at:
                typeof r.updated_at === 'string'
                  ? r.updated_at
                  : new Date().toISOString(),
              ...r,
            };
            t.push(fresh);
            upserted.push({ ...fresh });
          }
        }
        return { data: upserted, error: null };
      }

      case 'delete': {
        const keep: Row[] = [];
        const removed: Row[] = [];
        for (const r of t) {
          if (this.matches(r)) removed.push({ ...r });
          else keep.push(r);
        }
        this.db.tables[this.table] = keep;
        return { data: removed, error: null };
      }
    }
  }

  private matches(row: Row): boolean {
    for (const f of this.filters) {
      const v = row[f.col];
      if (f.kind === 'eq') {
        if (v !== f.value) return false;
      } else if (f.kind === 'gte') {
        if (v == null) return false;
        if ((v as never) < (f.value as never)) return false;
      } else if (f.kind === 'in') {
        const arr = f.value as unknown[];
        if (!arr.includes(v)) return false;
      } else if (f.kind === 'is') {
        if (f.value === null) {
          if (v !== null && v !== undefined) return false;
        }
      } else if (f.kind === 'filter') {
        const [op, val] = f.value as [string, unknown];
        if (op === 'eq') {
          if (v !== val) return false;
        } else if (op === 'is') {
          if (val === null && v !== null && v !== undefined) return false;
        }
      }
    }
    return true;
  }
}

export interface InMemoryClient {
  from: (table: string) => QueryBuilder;
}

export function makeClient(db: InMemoryDb): InMemoryClient {
  return {
    from: (table: string) => new QueryBuilder(db, table),
  };
}
