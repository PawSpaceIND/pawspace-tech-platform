import { ensureFinancialLifecycleTables } from "./financial-lifecycle";
import { ensureFinancialRuntimeTables as ensureFinancialRuntimeSupportTables } from "./financial-runtime-schema";

type Db = D1Database;

// Ready flag only: no in-flight promise is shared across requests (a cancelled request's promise never settles).
let ready = false;

/**
 * Ensure the minimum production money-path schema exists before finance work can execute.
 *
 * payment_intents/financial_outbox stay owned by ensureFinancialLifecycleTables so there is one
 * declaration for those tables. The supplemental journal, partner-earning and settlement objects are
 * created by ensureFinancialRuntimeSupportTables. A failed bootstrap is never cached, so a later
 * invocation can retry after a transient D1 error.
 *
 * worker/index.ts awaits this before EVERY accepted API request. It used to hand the first request's
 * in-flight promise to every concurrent request; if that first request was cancelled mid-bootstrap
 * (the client went away), its promise never settled and every request that joined it hung until the
 * runtime killed it ("Worker threw exception"). Now the isolate remembers only a COMPLETED bootstrap,
 * and a request arriving before that runs the idempotent bootstrap itself.
 *
 * Keep this bootstrap additive and idempotent: it is a runtime safety invariant, not a substitute for
 * adopting the historical migration ledger on environments whose migration history predates CI.
 */
export async function ensureFinancialRuntimeSchema(db: Db) {
  if (ready) return;
  await ensureFinancialLifecycleTables(db);
  await ensureFinancialRuntimeSupportTables(db);
  ready = true;
}

/** Test-only reset for isolated database harnesses that create more than one D1 adapter per process. */
export function resetFinancialRuntimeSchemaForTests() {
  ready = false;
}
