/**
 * Shared setup for the executed voice suites: a real SQLite-backed D1 shape, the security tables the
 * auth layer needs, and a CRM contact/lead the policy gate can resolve a recipient against.
 *
 * Deliberately NOT a mock of the voice modules. Every voice suite that uses this drives the real
 * governance functions and asserts against the rows they actually wrote.
 */
import { DatabaseSync } from "node:sqlite";

/**
 * The D1 shape, plus `onSql(pattern, fn)`: a one-shot hook that runs immediately BEFORE the next
 * statement whose SQL matches.
 *
 * This is how the check-then-act windows are tested without putting a test hook into production code.
 * Registering on the pre-dial consent re-read, for instance, lets the test change the stored consent in
 * exactly the gap between the policy snapshot and the provider contact - which is the race itself,
 * rather than a stand-in for it.
 */
export function makeD1(sqlite) {
  const hooks = [];
  const fire = async (sql) => {
    const index = hooks.findIndex(hook => sql.includes(hook.pattern));
    if (index === -1) return;
    const [hook] = hooks.splice(index, 1);
    await hook.fn();
  };
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { await fire(sql); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { await fire(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => { await fire(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    onSql: (pattern, fn) => { hooks.push({ pattern, fn }); },
  };
}

/** The env every fully-unlocked UAT case needs. Values are test placeholders, not credentials. */
export function uatVoiceEnv(extra = {}) {
  return {
    PAWSPACE_VOICE_ENV: "uat",
    PAWSPACE_VOICE_UAT_APPROVED: "true",
    PAWSPACE_VOICE_UAT_ALLOWLIST: "+91 98765 43210",
    PAWSPACE_VOICE_TRANSPORT: "local_simulator_non_production",
    PAWSPACE_VOICE_STATUS_CALLBACK_URL: "https://uat.pawspace.in/api/voice-provider-webhook",
    EXOTEL_API_KEY: "test-key",
    EXOTEL_API_TOKEN: "test-token",
    EXOTEL_SID: "test-sid",
    EXOTEL_CALLER_ID: "08000000000",
    EXOTEL_VOICE_APP_ID: "123456",
    EXOTEL_WEBHOOK_SECRET: "test-webhook-secret",
    ...extra,
  };
}

export const ALLOWLISTED_PHONE = "9876543210";
export const OTHER_PHONE = "9000000001";

export function freshSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY;");
  return sqlite;
}

/** A CRM contact + open lead + booking the gate can resolve, so a refusal is never "no such recipient". */
export function seedRecipient(sqlite, { contactId = "CON-V1", leadId = "LEAD-V1", phone = ALLOWLISTED_PHONE, optOut = 0 } = {}) {
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,stage TEXT,next_action TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT,owner TEXT,service TEXT,status TEXT,last_outcome TEXT,call_attempts INTEGER DEFAULT 0,whatsapp_attempts INTEGER DEFAULT 0,first_action_at INTEGER,next_action_at INTEGER,opt_out INTEGER DEFAULT 0,assigned_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT OR REPLACE INTO crm_contacts (id,name,primary_phone,stage,next_action,updated_at) VALUES (?,?,?,?,?,?)").run(contactId, "Voice UAT contact", phone, "New", "Call", now);
  sqlite.prepare("INSERT OR REPLACE INTO lead_work_items (id,customer_id,owner,service,status,call_attempts,whatsapp_attempts,opt_out,assigned_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?,?)").run(leadId, contactId, "rep@pawspace.in", "grooming", "open", optOut, now, now);
  return { contactId, leadId, phone };
}

export const FOUNDER_PERMISSIONS = ["*"];
export const OPERATOR_PERMISSIONS = ["communications.call", "customers.manage", "dashboard.view"];
export const PROVIDER_PERMISSIONS = ["communications.call", "bookings.view", "self_service.view"];
export const AUDITOR_PERMISSIONS = ["dashboard.view", "reports.view", "audit.view"];

/** A time known to be OUTSIDE the default 21:00-08:00 IST quiet window, and one known to be inside. */
export function istAt(hour, dayOffset = 0) {
  const base = Date.UTC(2026, 8, 14 + dayOffset, 0, 0, 0);
  return base + hour * 3_600_000 - 330 * 60_000;
}
export const DAYTIME = istAt(14);
export const QUIET_TIME = istAt(23);
