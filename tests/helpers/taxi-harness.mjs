/**
 * Shared setup for the EXECUTED Pet Taxi suites.
 *
 * The taxi gate suites used to read `lib/taxi-governance.ts` (and the lifecycle and finance modules)
 * as a string and regex-match them. A test named "Pet Taxi quote binds one canonical trip reservation"
 * asserted that the phrase "exactly one canonical trip reservation" appeared in the source; it would
 * have passed with the guard deleted and the sentence left behind in a comment.
 *
 * These helpers exist so every taxi assertion runs the real function against a real SQLite-backed D1
 * and reads the rows back. There is deliberately no taxi module mocked here: the modules own their own
 * DDL through their `ensure*Tables` exports, so a suite calls those and gets the production schema
 * rather than a hand-copied one that can drift from it.
 */
import { DatabaseSync } from "node:sqlite";

/**
 * The D1 surface the taxi modules use: prepare/bind/first/run/all, plus batch and exec.
 *
 * `batch` runs inside a real transaction so a failing statement rolls the whole batch back, which is
 * what D1 does and what the ensure*Tables + seed paths assume.
 */
export function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

export function freshSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY;");
  return sqlite;
}

/**
 * A NON-PREVIEW origin for every request these suites build.
 *
 * lib/development-preview.ts grants an authentication-free superuser holding ["*"] on localhost,
 * 127.0.0.1 and terminal.local when the runtime declares development/test — and `npm test` declares
 * exactly that. Any authorization assertion posted to those hosts passes vacuously, so the taxi suites
 * use a hostname the preview branch cannot match.
 */
export const OPS_ORIGIN = "https://ops.pawspace.example";
export const taxiUrl = (path) => `${OPS_ORIGIN}${path}`;

/**
 * A pickup time comfortably in the future; createTaxiQuote refuses anything at or before now.
 *
 * TRUNCATED TO A WHOLE SECOND on purpose. The instant-normalisation test compares the same moment
 * written as `...Z` and as `...+05:30`, and the +05:30 spelling comes from a formatter that has no
 * millisecond field — so a pickup carrying 126ms is genuinely a different instant in the two spellings
 * and `sameInstant` correctly refuses it. Rounding here keeps that test about normalisation instead of
 * about formatter precision. (Confirmed by running it: the refusal was the fixture's fault, not the
 * guard's.)
 */
export const futurePickup = (offsetMinutes = 180) =>
  new Date(Math.floor((Date.now() + offsetMinutes * 60_000) / 1000) * 1000).toISOString();

/**
 * A quote that is valid in every respect, so a test can vary ONE field and attribute the refusal to
 * that field rather than to fixture drift.
 */
export function validQuoteInput(overrides = {}) {
  return {
    routeCode: "taxi-blr-east-short",
    originLabel: "Indiranagar pickup point",
    destinationLabel: "Whitefield veterinary clinic",
    petCount: 1,
    scheduledStart: futurePickup(),
    paymentMode: "sandbox_deferred",
    ...overrides,
  };
}

/** The status a thrown control Response carries, or null when the value is not one. */
export async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (!(error instanceof Response)) throw error;
    return { status: error.status, message: await error.text().catch(() => "") };
  }
}
