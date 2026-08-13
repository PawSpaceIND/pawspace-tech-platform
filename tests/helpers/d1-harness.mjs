/**
 * Shared D1 test harness.
 *
 * Every suite used to build its own D1 shim over node:sqlite, and each one was more permissive than
 * the real database. Two production defects walked straight through that gap:
 *
 *   /api/unit-economics   "D1_ERROR: too many SQL variables at offset 301"
 *                         node:sqlite accepts thousands of bound parameters; D1 caps them near 100.
 *
 *   /api/customer-360     "Too many API requests by single Worker invocation"
 *                         8 queries per customer x up to 1,000 customers. No shim counted calls, so
 *                         nothing failed until a real Worker refused to make the 1,001st subrequest.
 *
 * This harness models both limits. The two guards catch different things and both are needed:
 *
 *   the bind cap    catches ONE statement that is too wide
 *   the call budget catches MANY statements that are individually fine  <- catches N+1 itself
 *
 * A bind cap alone would not have failed the original customer-360 loop at all: 8 narrow queries per
 * customer are each perfectly legal. Assert the property that would actually break in production.
 */

import { DatabaseSync } from "node:sqlite";

/** D1 rejects a statement with more than ~100 bound parameters. */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * A D1 shim over node:sqlite that enforces the bind cap and counts calls.
 *
 * @param sqlite a node:sqlite DatabaseSync
 * @param options.maxBoundParams override the bind cap (rarely needed)
 * @returns { db, calls(), reset() } - `calls()` is the D1 subrequest count since the last reset
 */
export function makeCountingD1(sqlite, options = {}) {
  const maxBoundParams = options.maxBoundParams ?? D1_MAX_BOUND_PARAMS;
  let calls = 0;

  function statement(sql, args) {
    if (args.length > maxBoundParams) {
      throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${maxBoundParams}): ${String(sql).slice(0, 90)}`);
    }
    return {
      sql, args,
      bind: (...bound) => statement(sql, bound),
      first: async () => { calls++; const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { calls++; const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { calls++; return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }

  const db = {
    prepare: (sql) => statement(sql, []),
    // Real D1 charges a batch as ONE subrequest regardless of statement count. Model that, or the
    // budget would punish batching - the very thing we want code to do.
    batch: async (statements) => {
      calls++;
      const results = [];
      for (const item of statements) {
        const info = sqlite.prepare(item.sql).run(...(item.args ?? []));
        results.push({ success: true, meta: { changes: Number(info.changes) } });
      }
      return results;
    },
    exec: async (sql) => { calls++; sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };

  return { db, calls: () => calls, reset: () => { calls = 0; } };
}

/** Convenience: a fresh in-memory database wired to the counting shim. */
export function freshCountingD1(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const harness = makeCountingD1(sqlite, options);
  return { sqlite, ...harness };
}

/**
 * Assert a block of work stays inside a D1 subrequest budget.
 * Also asserts a floor, so a budget cannot pass because the work silently did nothing.
 */
export async function assertWithinBudget(harness, { max, min = 1, label }, work) {
  const assert = (await import("node:assert/strict")).default;
  harness.reset();
  const value = await work();
  const used = harness.calls();
  assert.ok(used <= max, `${label}: expected at most ${max} D1 calls, used ${used}`);
  assert.ok(used >= min, `${label}: only ${used} D1 calls - did the work actually run?`);
  return value;
}
