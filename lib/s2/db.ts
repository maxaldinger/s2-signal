// SingleStore connection pool. SingleStore speaks the MySQL wire protocol, so
// the app uses mysql2 — there is no Postgres driver or PostgREST in this
// build. Server-only: credentials come from env and never reach the browser.

import fs from "node:fs";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";

declare global {
  // One pool per process, reused across Next.js dev hot reloads.
  var __s2pool: Pool | undefined;
}

export function s2Configured(): boolean {
  return Boolean(
    process.env.SINGLESTORE_HOST?.trim() &&
      process.env.SINGLESTORE_USER?.trim() &&
      process.env.SINGLESTORE_PASSWORD,
  );
}

function createPool(): Pool {
  const ca = process.env.SINGLESTORE_SSL_CA?.trim();
  return mysql.createPool({
    host: process.env.SINGLESTORE_HOST?.trim(),
    port: Number(process.env.SINGLESTORE_PORT || 3306),
    user: process.env.SINGLESTORE_USER?.trim(),
    password: process.env.SINGLESTORE_PASSWORD,
    database: process.env.SINGLESTORE_DATABASE?.trim() || "gtm_dashboard",
    // Helios endpoints require TLS; Node's trust store covers them unless a
    // CA bundle path is given.
    ssl: ca ? { ca: fs.readFileSync(ca, "utf8") } : { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionLimit: 12,
    // Every DATETIME is written as UTC (see toSqlValue) and read back as an
    // ISO-8601 string with "Z", matching what the Postgres timestamptz
    // columns returned to the rest of the app.
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    typeCast(field, next) {
      if (field.type === "DATETIME" || field.type === "TIMESTAMP") {
        const s = field.string();
        return s ? `${s.replace(" ", "T")}Z` : null;
      }
      return next();
    },
  });
}

export function pool(): Pool {
  if (!s2Configured()) {
    throw new Error(
      "SingleStore is not configured: set SINGLESTORE_HOST, SINGLESTORE_USER and SINGLESTORE_PASSWORD in .env.local.",
    );
  }
  if (!globalThis.__s2pool) {
    const p = createPool();
    // Pin every session to UTC so NOW(6) defaults agree with app-written times.
    p.on("connection", (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });
    globalThis.__s2pool = p;
  }
  return globalThis.__s2pool;
}

export interface Timed<T> {
  rows: T[];
  sql: string;
  ms: number;
}

/** Run one statement; returns rows, the SQL text and round-trip latency. */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  conn?: PoolConnection,
): Promise<Timed<T>> {
  const t0 = performance.now();
  const [rows] = await (conn ?? pool()).query(sql, params);
  return { rows: rows as T[], sql, ms: Math.round(performance.now() - t0) };
}

export async function tx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** JS value -> SQL parameter. ISO timestamps become UTC DATETIME literals,
 *  objects/arrays become JSON text. */
export function toSqlValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return utc(v);
  if (typeof v === "string" && ISO_DT.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : utc(d);
  }
  if (v !== null && typeof v === "object" && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

function utc(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}
