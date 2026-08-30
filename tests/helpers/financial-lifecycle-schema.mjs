import fs from "node:fs";

const migrations = [
  "../../drizzle/0017_financial_lifecycle_hardening.sql",
  "../../drizzle/0018_financial_lifecycle_split_intents.sql",
  "../../drizzle/0019_razorpay_settlement_reconciliation.sql",
];

/** Apply the real finance migrations to a legacy in-memory SQLite fixture. */
export function installFinancialLifecycleSchema(sqlite) {
  for (const migration of migrations) {
    sqlite.exec(fs.readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
}
