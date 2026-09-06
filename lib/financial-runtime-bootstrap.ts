import { ensureFinancialLifecycleTables } from "./financial-lifecycle";
import { ensureFinancialRuntimeSupportTables } from "./financial-runtime-schema";

type Db = D1Database;

let ready: Promise<void> | null = null;

/**
 * Ensure the minimum production money-path schema exists before finance work can execute.
 *
 * payment_intents/financial_outbox stay owned by ensureFinancialLifecycleTables so there is one
 * declaration for those tables. The supplemental journal, partner-earning and settlement objects are
 * created by ensureFinancialRuntimeSupportTables. A failed bootstrap is never cached, so a later
 * invocation can retry after a transient D1 error.
 *
 * Keep this bootstrap additive and idempotent: it is a runtime safety invariant, not a substitute for
 * adopting the historical migration ledger on environments whose migration history predates CI.
 */
export function ensureFinancialRuntimeSchema(db: Db) {
  if (!ready) {
    ready = (async () => {
      await ensureFinancialLifecycleTables(db);
      await ensureFinancialRuntimeSupportTables(db);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/** Test-only reset for isolated database harnesses that create more than one D1 adapter per process. */
export function resetFinancialRuntimeSchemaForTests() {
  ready = null;
}
