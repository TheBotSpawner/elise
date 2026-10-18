/**
 * A tiny in-memory stand-in for the Supabase query builder: enough of select / insert / update /
 * upsert / delete with eq, neq, lt, is and in filters to run application services in unit
 * tests. Not a database: no RLS, no types — those are covered by the PGlite integration tests.
 */

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  /** Column defaults per table, as the real schema would fill them on insert. */
  readonly defaults: Record<string, Row> = {};

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  from(table: string) {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private conflict: string[] = [];
  private returning = false;
  /** `select(cols, { count: "exact", head: true })`: the count, no rows. */
  private counting: { head: boolean } | null = null;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.returning = true;
    if (opts?.count) this.counting = { head: Boolean(opts.head) };
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict?: string } = {}) {
    this.op = "upsert";
    this.payload = rows;
    this.conflict = (opts.onConflict ?? "id").split(",");
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters.push((r) => r[k] === v);
    return this;
  }
  neq(k: string, v: unknown) {
    this.filters.push((r) => r[k] !== v);
    return this;
  }
  lt(k: string, v: unknown) {
    this.filters.push((r) => String(r[k] ?? "") < String(v));
    return this;
  }
  gt(k: string, v: unknown) {
    this.filters.push((r) => String(r[k] ?? "") > String(v));
    return this;
  }
  gte(k: string, v: unknown) {
    this.filters.push((r) => String(r[k] ?? "") >= String(v));
    return this;
  }
  lte(k: string, v: unknown) {
    this.filters.push((r) => String(r[k] ?? "") <= String(v));
    return this;
  }
  /** Only `not(col, "is", null)`. */
  not(k: string, _op: "is", v: unknown) {
    this.filters.push((r) => (r[k] ?? null) !== v);
    return this;
  }
  /** jsonb array containment: the column holds every given value. */
  contains(k: string, v: unknown[]) {
    this.filters.push(
      (r) => Array.isArray(r[k]) && v.every((x) => (r[k] as unknown[]).includes(x)),
    );
    return this;
  }
  range() {
    return this;
  }
  is(k: string, v: unknown) {
    this.filters.push((r) => (r[k] ?? null) === v);
    return this;
  }
  in(k: string, v: unknown[]) {
    this.filters.push((r) => v.includes(r[k]));
    return this;
  }
  /** PostgREST `or`, for the `col.in.(a,b),col.eq.x` forms ELISE uses. */
  or(expr: string) {
    const conds = [...expr.matchAll(/(\w+)\.(in|eq)\.(\(([^)]*)\)|[^,]+)/g)].map((m) => ({
      col: m[1]!,
      values: m[2] === "in" ? m[4]!.split(",") : [m[3]!],
    }));
    this.filters.push((r) => conds.some((c) => c.values.includes(String(r[c.col]))));
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }

  private run(): Row[] {
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    switch (this.op) {
      case "select":
        return rows.filter(match);
      case "insert": {
        const added = [this.payload]
          .flat()
          .map((r) => ({ id: crypto.randomUUID(), ...this.db.defaults[this.table], ...r }) as Row);
        rows.push(...added);
        return added;
      }
      case "update": {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, this.payload);
        return hit;
      }
      case "upsert":
        return [this.payload].flat().map((row) => {
          const r = row as Row;
          const existing = rows.find((x) => this.conflict.every((k) => x[k] === r[k]));
          if (existing) return Object.assign(existing, r);
          const added = { id: crypto.randomUUID(), ...this.db.defaults[this.table], ...r };
          rows.push(added);
          return added;
        });
      case "delete": {
        const hit = rows.filter(match);
        this.db.tables.set(
          this.table,
          rows.filter((r) => !hit.includes(r)),
        );
        return hit;
      }
    }
  }

  async maybeSingle() {
    const rows = this.run();
    return { data: rows[0] ?? null, error: null };
  }
  async single() {
    const rows = this.run();
    return { data: rows[0] ?? null, error: rows[0] ? null : { message: "no rows" } };
  }
  then<T1 = { data: unknown; error: null }, T2 = never>(
    ok?: ((v: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    fail?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    try {
      const rows = this.run();
      return Promise.resolve({
        data: this.counting?.head ? null : this.returning || this.op === "select" ? rows : null,
        error: null,
        ...(this.counting ? { count: rows.length } : {}),
      }).then(ok, fail);
    } catch (e) {
      return Promise.reject(e).then(ok, fail);
    }
  }
}
