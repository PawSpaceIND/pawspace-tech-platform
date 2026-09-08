/*
 * A small harness for converting source-text tests into executing ones.
 *
 * A third of this suite's test files assert on source text and never call the module they claim to
 * cover. Converting one meant re-writing the same D1 shim and actor seeding each time, which is
 * friction in the wrong direction. This centralises it.
 *
 * NOT a mock: the shim is a thin adapter from D1's API onto node:sqlite, so the module under test
 * runs its real SQL against a real database engine.
 */
import { DatabaseSync } from "node:sqlite";
import { enterWorkersDbScope } from "./module-hooks.mjs";

/** Adapter from the D1 interface onto node:sqlite. Real SQL, real engine, no stubbed behaviour. */
export function d1(sqlite) {
  let batchSeq = 0;
  let batchQueue = Promise.resolve();
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async (col) => {
      const row = sqlite.prepare(sql).get(...args);
      if (row === undefined) return null;
      return col ? row[col] : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
    raw: async () => sqlite.prepare(sql).all(...args).map((r) => Object.values(r)),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      // Cloudflare D1 batches are transactional: a failing statement rolls back the full sequence.
      // SAVEPOINT keeps that contract even when a test opens an outer SQLite transaction.
      // Multiple concurrent batch calls on the same SQLite handle (e.g. via Promise.all) must run
      // consecutively so interleaved savepoint releases do not invalidate each other.
      const runBatch = async () => {
        const savepoint = `d1_batch_${++batchSeq}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        const out = [];
        try {
          for (const s of list) out.push(await s.run());
          sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return out;
        } catch (error) {
          sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      };

      const previous = batchQueue;
      let nextResolve;
      batchQueue = new Promise((resolve) => { nextResolve = resolve; });
      try {
        await previous;
        return await runBatch();
      } finally {
        nextResolve();
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A fresh in-memory database wired to the globals installWorkersHooks was configured with. */
export function world(dbGlobal, envGlobal, env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  // Bind first so every import/promise spawned by this node:test callback resolves env.DB from this
  // async scope. The named global remains only as a compatibility fallback for code that executes
  // outside an active test scope; it is no longer the active-world selector.
  enterWorkersDbScope(db);
  globalThis[dbGlobal] = db;
  globalThis[envGlobal] = env;
  return { sqlite, db };
}

/*
 * A REAL https origin, never localhost.
 *
 * lib/development-preview.ts grants superuser ["*"] on localhost / 127.0.0.1 / terminal.local, and
 * the suite runs with PAWSPACE_LOCAL_PREVIEW=on. A route test driven from localhost therefore passes
 * as a superuser and proves nothing about the permission model - which is how ~185 tests in this
 * suite pass today. Any converted test that drives a route must use this.
 */
export const ORIGIN = "https://app.pawspace.in";

/** Seed real app_users rows so authorization resolves against canonical state, not a header claim. */
export async function seedActors(sqlite, db, actors) {
  const { ensureSecurityTables } = await import("../../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const { id, email, role } of actors) {
    sqlite.prepare(
      "INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)",
    ).run(id, email, email, role, now, now);
  }
}

/** Build a Request as a given identity. */
export const asActor = (email, path, init = {}) =>
  new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { "oai-authenticated-user-email": email, "content-type": "application/json", ...(init.headers || {}) },
  });

/** Run a call that may throw a Response, returning a uniform result either way. */
export async function attempt(fn) {
  try {
    const value = await fn();
    if (value instanceof Response) return { ok: value.ok, status: value.status, body: await value.clone().text() };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Response) return { ok: false, status: error.status, body: await error.clone().text() };
    return { ok: false, status: 500, body: String(error?.message ?? error) };
  }
}