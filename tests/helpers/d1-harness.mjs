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
 * This harness models those limits. The guards catch different things and all three are needed:
 *
 *   the bind cap    catches ONE statement that is too wide
 *   the call budget catches MANY statements that are individually fine  <- catches N+1 itself
 *   the row meter   catches FEW statements that each drag back far more data than the caller uses
 *
 * A bind cap alone would not have failed the original customer-360 loop at all: 8 narrow queries per
 * customer are each perfectly legal. Assert the property that would actually break in production.
 *
 * The row meter was added after a third defect that the first two guards provably could not see:
 *
 *   /api/ai-business-configuration?mode=status
 *                         called aiBusinessConfigurationSnapshot to compute two integers. That is a
 *                         FIXED six queries whether there are ten configuration versions or a
 *                         thousand, so the call count never moved - but it transferred up to 100
 *                         profiles, 200 intents, 200 knowledge sources, 100 prompt policies and 200
 *                         audit events to produce two numbers. Measured: 373 rows against 100+
 *                         versions versus 88 against 10. Cost that scales with history, at a
 *                         constant call count.
 */

import { DatabaseSync } from "node:sqlite";
import { createD1 } from "./d1.mjs";

/** D1 rejects a statement with more than ~100 bound parameters. Declared once, in the D1 shim. */
export { D1_MAX_BOUND_PARAMS } from "./d1.mjs";
import { D1_MAX_BOUND_PARAMS } from "./d1.mjs";

/**
 * A D1 shim over node:sqlite that enforces the bind cap and counts calls.
 *
 * @param sqlite a node:sqlite DatabaseSync
 * @param options.maxBoundParams override the bind cap (rarely needed)
 * @returns { db, calls(), reset() } - `calls()` is the D1 subrequest count since the last reset
 */
export function makeCountingD1(sqlite, options = {}) {
  let calls = 0;
  let rows = 0;

  // The metering wraps createD1 rather than re-implementing a shim. This harness used to carry its
  // own, whose batch() committed statement by statement - so a suite could hold a call budget while
  // measuring atomicity against a machine that does not roll back. One shim, both properties.
  const inner = createD1(sqlite, { maxBoundParams: options.maxBoundParams ?? D1_MAX_BOUND_PARAMS });

  /** Meters the three reads/writes and leaves the internals (including __runInTransaction) intact. */
  function meter(statement) {
    return {
      ...statement,
      bind: (...bound) => meter(statement.bind(...bound)),
      first: async () => { calls++; const row = await statement.first(); if (row !== null) rows++; return row; },
      all: async () => { calls++; const out = await statement.all(); rows += out.results.length; return out; },
      run: async () => { calls++; return statement.run(); },
    };
  }

  const db = {
    prepare: (sql) => meter(inner.prepare(sql)),
    // Real D1 charges a batch as ONE subrequest regardless of statement count. Model that, or the
    // budget would punish batching - the very thing we want code to do.
    batch: async (statements) => { calls++; return inner.batch(statements); },
    exec: async (sql) => { calls++; return inner.exec(sql); },
  };

  return { db, calls: () => calls, rows: () => rows, reset: () => { calls = 0; rows = 0; } };
}

/** Convenience: a fresh in-memory database wired to the counting shim. */
export function freshCountingD1(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const harness = makeCountingD1(sqlite, options);
  return { sqlite, ...harness };
}

/**
 * Assert a block of work stays inside a D1 subrequest budget, and optionally a row budget.
 * Also asserts a floor, so a budget cannot pass because the work silently did nothing.
 *
 * @param budget.max     maximum D1 subrequests
 * @param budget.min     minimum D1 subrequests (default 1) - proves the work ran
 * @param budget.maxRows optional maximum rows returned; set it when the caller uses far less data
 *                       than a convenient existing helper would fetch
 */
export async function assertWithinBudget(harness, { max, min = 1, maxRows, label }, work) {
  const assert = (await import("node:assert/strict")).default;
  harness.reset();
  const value = await work();
  const used = harness.calls();
  assert.ok(used <= max, `${label}: expected at most ${max} D1 calls, used ${used}`);
  assert.ok(used >= min, `${label}: only ${used} D1 calls - did the work actually run?`);
  if (maxRows !== undefined) {
    const read = harness.rows();
    assert.ok(read <= maxRows, `${label}: expected at most ${maxRows} rows, read ${read} - the work is dragging back data it does not use`);
  }
  return value;
}

/**
 * Assert a read does NOT get more expensive as the data behind it grows - the property a fixed call
 * budget cannot express. Runs the work, grows the data, runs it again, and compares both meters.
 */
export async function assertDoesNotScale(harness, { label }, work, grow) {
  const assert = (await import("node:assert/strict")).default;
  harness.reset();
  await work();
  const before = { calls: harness.calls(), rows: harness.rows() };
  await grow();
  harness.reset();
  await work();
  const after = { calls: harness.calls(), rows: harness.rows() };
  assert.equal(after.calls, before.calls, `${label}: D1 calls grew with the data (${before.calls} -> ${after.calls})`);
  assert.equal(after.rows, before.rows, `${label}: rows read grew with the data (${before.rows} -> ${after.rows})`);
  return before;
}
