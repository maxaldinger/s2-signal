// A Supabase-compatible query builder backed by SingleStore SQL.
//
// The original dashboard talks to Postgres through supabase-js
// (`sb.from("t").select(...).eq(...).maybeSingle()`). Rather than rewrite
// every route, this implements the subset of that interface the app uses —
// select / eq / neq / in / is / gt(e) / lt(e) / order / range / limit /
// single / maybeSingle / insert / upsert / update / delete — and compiles it
// to parameterised MySQL-dialect SQL. Results come back in supabase-js's
// `{ data, error, count }` shape and errors are returned, never thrown.
//
// Row-level security: the Postgres build relied on RLS to keep per-user rows
// private. A client created for a user (`userScoped`) re-implements those
// policies: every read/write on a PER_USER table is filtered to, and stamped
// with, that user's id.

import { randomUUID } from "node:crypto";
import { q, toSqlValue } from "./db";

// Rows are untyped, as with an untyped supabase-js client: callers narrow them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export interface S2Error {
  message: string;
  code?: string;
}
export interface S2Result<T> {
  data: T;
  error: S2Error | null;
  count?: number | null;
}

/** Tables whose rows belong to one user (the RLS-protected ones). */
const PER_USER = new Set(["gtm_user_state"]);

/** Tables keyed by a generated uuid `id`. */
const UUID_ID = new Set([
  "gtm_signals", "gtm_github_signals", "gtm_sync_events", "gtm_prospects", "gtm_sequences",
  "gtm_sequence_steps", "gtm_enrollments", "gtm_action_log", "gtm_sequence_events",
  "gtm_m365_mailboxes", "gtm_users",
]);

/** JSON / BOOL columns per table, decoded on read. */
const JSON_COLS: Record<string, string[]> = {
  gtm_signals: ["tags"],
  gtm_briefs: ["intel"],
  gtm_state: ["value"],
  gtm_user_state: ["value"],
  gtm_proposals: ["fields"],
  gtm_monitored_repos: ["poll_cursor"],
  gtm_enriched_contacts: ["signal_summary"],
  gtm_sequence_events: ["payload"],
};
const BOOL_COLS: Record<string, string[]> = {
  gtm_monitored_repos: ["active"],
  gtm_prospects: ["do_not_contact"],
  gtm_sequences: ["active"],
  gtm_m365_mailboxes: ["active", "needs_reconnect"],
};

/** Table names arrive in the original schema's naming; map them to this one. */
export function tableName(t: string): string {
  const name = t.replace(/^bito_/, "gtm_");
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Bad table name ${t}`);
  return name;
}

const ident = (c: string) => {
  const name = c.trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Bad column name "${c}"`);
  return `\`${name}\``;
};

function decode(table: string, row: Row): Row {
  for (const c of JSON_COLS[table] ?? []) {
    const v = row[c];
    if (typeof v === "string") {
      try {
        row[c] = JSON.parse(v);
      } catch {
        /* leave as text */
      }
    }
  }
  for (const c of BOOL_COLS[table] ?? []) {
    if (c in row && row[c] !== null) row[c] = Boolean(Number(row[c]));
  }
  return row;
}

type Filter = { sql: string; params: unknown[] };
type Op = "select" | "insert" | "upsert" | "update" | "delete";

export class QueryBuilder<T = Row[]> implements PromiseLike<S2Result<T>> {
  private op: Op = "select";
  private cols = "*";
  private wantCount = false;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private lim?: number;
  private off?: number;
  private mode: "many" | "single" | "maybe" = "many";
  private payload: Row[] = [];
  private patch: Row = {};
  private onConflict?: string[];
  private ignoreDuplicates = false;
  private returning = false;

  constructor(
    private readonly table: string,
    private readonly userId: string | null,
  ) {}

  // ---- statements -------------------------------------------------------
  select(cols = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    if (this.op === "select") {
      this.cols = cols;
      this.wantCount = Boolean(opts?.count);
    } else {
      this.returning = true; // insert(...).select(): return the written rows
      this.cols = cols;
    }
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts?.onConflict?.split(",").map((s) => s.trim()).filter(Boolean);
    this.ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  // ---- filters ------------------------------------------------------------
  private add(sql: string, ...params: unknown[]) {
    this.filters.push({ sql, params });
    return this;
  }
  eq(c: string, v: unknown) {
    return v === null ? this.add(`${ident(c)} IS NULL`) : this.add(`${ident(c)} = ?`, toSqlValue(v));
  }
  neq(c: string, v: unknown) {
    return v === null ? this.add(`${ident(c)} IS NOT NULL`) : this.add(`${ident(c)} <> ?`, toSqlValue(v));
  }
  gt(c: string, v: unknown) {
    return this.add(`${ident(c)} > ?`, toSqlValue(v));
  }
  gte(c: string, v: unknown) {
    return this.add(`${ident(c)} >= ?`, toSqlValue(v));
  }
  lt(c: string, v: unknown) {
    return this.add(`${ident(c)} < ?`, toSqlValue(v));
  }
  lte(c: string, v: unknown) {
    return this.add(`${ident(c)} <= ?`, toSqlValue(v));
  }
  in(c: string, vs: unknown[]) {
    if (!vs.length) return this.add("1 = 0");
    return this.add(`${ident(c)} IN (${vs.map(() => "?").join(",")})`, ...vs.map(toSqlValue));
  }
  is(c: string, v: null | boolean) {
    return v === null ? this.add(`${ident(c)} IS NULL`) : this.add(`${ident(c)} = ?`, v);
  }
  not(c: string, operator: string, v: unknown) {
    if (operator === "is" && v === null) return this.add(`${ident(c)} IS NOT NULL`);
    if (operator === "eq") return this.neq(c, v);
    throw new Error(`not(${operator}) is not supported`);
  }
  ilike(c: string, pattern: string) {
    return this.add(`LOWER(${ident(c)}) LIKE LOWER(?)`, pattern);
  }
  /** Escape hatch for conditions the builder doesn't model (SQL fragment + params). */
  whereSql(sql: string, ...params: unknown[]) {
    return this.add(`(${sql})`, ...params.map(toSqlValue));
  }

  // ---- shaping ------------------------------------------------------------
  order(c: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    const asc = opts?.ascending !== false;
    if (opts?.nullsFirst !== undefined) {
      this.orders.push(`(${ident(c)} IS NULL) ${opts.nullsFirst ? "DESC" : "ASC"}`);
    }
    this.orders.push(`${ident(c)} ${asc ? "ASC" : "DESC"}`);
    return this;
  }
  limit(n: number) {
    this.lim = Math.max(0, Math.floor(n));
    return this;
  }
  range(from: number, to: number) {
    this.off = Math.max(0, Math.floor(from));
    this.lim = Math.max(0, Math.floor(to) - this.off + 1);
    return this;
  }
  single() {
    this.mode = "single";
    return this as unknown as QueryBuilder<Row>;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this as unknown as QueryBuilder<Row | null>;
  }

  // ---- execution ------------------------------------------------------------
  then<R1 = S2Result<T>, R2 = never>(
    ok?: ((v: S2Result<T>) => R1 | PromiseLike<R1>) | null,
    fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(ok, fail);
  }

  private scope() {
    if (this.userId && PER_USER.has(this.table)) this.add("`user_id` = ?", this.userId);
  }
  private where(): { sql: string; params: unknown[] } {
    if (!this.filters.length) return { sql: "", params: [] };
    return {
      sql: ` WHERE ${this.filters.map((f) => f.sql).join(" AND ")}`,
      params: this.filters.flatMap((f) => f.params),
    };
  }
  private colList(): string {
    if (this.cols.trim() === "*") return "*";
    return this.cols.split(",").map(ident).join(", ");
  }

  private async execute(): Promise<S2Result<T>> {
    try {
      this.scope();
      switch (this.op) {
        case "select":
          return await this.runSelect();
        case "insert":
        case "upsert":
          return await this.runWrite();
        case "update":
          return await this.runUpdate();
        case "delete":
          return await this.runDelete();
      }
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return { data: (this.mode === "many" ? [] : null) as T, error: { message: err.message ?? String(e), code: err.code } };
    }
  }

  private shape(rows: Row[]): S2Result<T> {
    const decoded = rows.map((r) => decode(this.table, { ...r }));
    if (this.mode === "many") return { data: decoded as T, error: null };
    if (decoded.length > 1 && this.mode === "single") {
      return { data: null as T, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
    }
    if (!decoded.length && this.mode === "single") {
      return { data: null as T, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
    }
    return { data: (decoded[0] ?? null) as T, error: null };
  }

  private async runSelect(): Promise<S2Result<T>> {
    const w = this.where();
    let sql = `SELECT ${this.colList()} FROM ${this.table}${w.sql}`;
    if (this.orders.length) sql += ` ORDER BY ${this.orders.join(", ")}`;
    const lim = this.mode === "many" ? this.lim : Math.min(this.lim ?? 2, 2);
    if (lim !== undefined) sql += ` LIMIT ${lim}`;
    if (this.off) sql += `${lim === undefined ? " LIMIT 18446744073709551615" : ""} OFFSET ${this.off}`;
    const r = await q<Row>(sql, w.params);
    const out = this.shape(r.rows);
    if (this.wantCount) {
      const c = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.table}${w.sql}`, w.params);
      out.count = Number(c.rows[0]?.n ?? 0);
    }
    return out;
  }

  private async runWrite(): Promise<S2Result<T>> {
    if (!this.payload.length) return { data: [] as T, error: null };
    const rows = this.payload.map((r) => {
      const row: Row = { ...r };
      if (UUID_ID.has(this.table) && (row.id === undefined || row.id === null)) row.id = randomUUID();
      if (this.userId && PER_USER.has(this.table)) row.user_id = this.userId;
      return row;
    });
    const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const values = rows.map(() => `(${cols.map(() => "?").join(",")})`).join(", ");
    const params = rows.flatMap((r) => cols.map((c) => toSqlValue(r[c])));
    let sql = `INSERT INTO ${this.table} (${cols.map(ident).join(", ")}) VALUES ${values}`;
    if (this.op === "upsert") {
      const keys = new Set([...(this.onConflict ?? []), "id"]);
      const updatable = cols.filter((c) => !keys.has(c));
      if (this.ignoreDuplicates || !updatable.length) {
        sql = sql.replace(/^INSERT/, "INSERT IGNORE");
      } else {
        sql += ` ON DUPLICATE KEY UPDATE ${updatable.map((c) => `${ident(c)} = VALUES(${ident(c)})`).join(", ")}`;
      }
    }
    await q(sql, params);
    if (!this.returning) return { data: null as T, error: null };
    // supabase-js returns the written rows; we return what was written,
    // projected to the requested columns.
    const pick = this.cols.trim() === "*" ? null : this.cols.split(",").map((s) => s.trim());
    const written = rows.map((r) => (pick ? Object.fromEntries(pick.map((c) => [c, r[c] ?? null])) : r));
    return this.shape(written);
  }

  private async runUpdate(): Promise<S2Result<T>> {
    const entries = Object.entries(this.patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return { data: null as T, error: null };
    const w = this.where();
    if (!w.sql) throw new Error("update() without a filter is not allowed");
    const sql = `UPDATE ${this.table} SET ${entries.map(([c]) => `${ident(c)} = ?`).join(", ")}${w.sql}`;
    await q(sql, [...entries.map(([, v]) => toSqlValue(v)), ...w.params]);
    return { data: null as T, error: null };
  }

  private async runDelete(): Promise<S2Result<T>> {
    const w = this.where();
    if (!w.sql) throw new Error("delete() without a filter is not allowed");
    await q(`DELETE FROM ${this.table}${w.sql}`, w.params);
    return { data: null as T, error: null };
  }
}

/** A database client. `userId` makes per-user tables behave as RLS did. */
export function s2Client(userId: string | null = null) {
  return {
    from<T = Row[]>(table: string): QueryBuilder<T> {
      return new QueryBuilder<T>(tableName(table), userId);
    },
  };
}
export type S2Client = ReturnType<typeof s2Client>;
