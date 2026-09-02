/** Test boundary matching lib/voice-outbound-governance.ts canonical-recipient hardening. */
export * from "./voice-harness-core.mjs";
import { seedRecipient as seedCore } from "./voice-harness-core.mjs";

export function seedRecipient(sqlite, options = {}) {
  const seeded = seedCore(sqlite, options);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'voice_test',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'voice_test','{}',?,?)")
    .run(seeded.contactId, "blr", "Voice UAT contact", seeded.phone, now, now);
  return seeded;
}
