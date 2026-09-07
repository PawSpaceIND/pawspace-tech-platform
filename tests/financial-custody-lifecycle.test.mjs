import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const repoRoot = new URL("../", import.meta.url);
class Statement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sqlite, this.sql, values); }
  runSync() { const result = this.sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes || 0) } }; }
  run() { return Promise.resolve(this.runSync()); }
  first() { return Promise.resolve(this.sqlite.prepare(this.sql).get(...this.values) || null); }
  all() { return Promise.resolve({ results: this.sqlite.prepare(this.sql).all(...this.values) }); }
}
class Db {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec("PRAGMA foreign_keys = ON"); }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  batch(statements) { this.sqlite.exec("BEGIN IMMEDIATE"); try { const out = statements.map((s) => s.runSync()); this.sqlite.exec("COMMIT"); return Promise.resolve(out); } catch (error) { this.sqlite.exec("ROLLBACK"); return Promise.reject(error); } }
  exec(sql) { this.sqlite.exec(sql); }
  close() { this.sqlite.close(); }
}

async function loadFinance() {
  const tempDir = path.join(os.tmpdir(), `pawspace-custody-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  const transpile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler } }).outputText;
  await writeFile(path.join(tempDir, "payment-environment.mjs"), transpile(await readFile(new URL("lib/payment-environment.ts", repoRoot), "utf8")));
  await writeFile(path.join(tempDir, "payment-pilot-guard.mjs"), transpile(await readFile(new URL("lib/payment-pilot-guard.ts", repoRoot), "utf8")));
  const razor = (await readFile(new URL("lib/razorpay-client.ts", repoRoot), "utf8"))
    .replaceAll('from"./payment-environment"', 'from"./payment-environment.mjs"')
    .replaceAll('from"./payment-pilot-guard"', 'from"./payment-pilot-guard.mjs"');
  await writeFile(path.join(tempDir, "razorpay-client.mjs"), transpile(razor));
  await writeFile(path.join(tempDir, "financial-runtime-schema.mjs"), transpile(await readFile(new URL("lib/financial-runtime-schema.ts", repoRoot), "utf8")));
  const finance = (await readFile(new URL("lib/financial-lifecycle.ts", repoRoot), "utf8"))
    .replace('from "./financial-runtime-schema"', 'from "./financial-runtime-schema.mjs"')
    .replace('from "./razorpay-client"', 'from "./razorpay-client.mjs"');
  await writeFile(path.join(tempDir, "financial-lifecycle.mjs"), transpile(finance));
  const module = await import(`${pathToFileURL(path.join(tempDir, "financial-lifecycle.mjs")).href}?v=${Date.now()}`);
  return { module, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}

async function financeDb() {
  const db = new Db();
  db.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  db.exec(await readFile(new URL("drizzle/0017_financial_lifecycle_hardening.sql", repoRoot), "utf8"));
  db.exec(await readFile(new URL("drizzle/0018_financial_lifecycle_split_intents.sql", repoRoot), "utf8"));
  db.exec(`CREATE TABLE booking_cancellation_cases (
    id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL,
    finance_decision TEXT, finance_decision_by TEXT, finance_decision_at INTEGER
  )`);
  return db;
}
async function seedEarning(db, finance, bookingId, earningId) {
  db.exec(`INSERT INTO canonical_bookings (id,status) VALUES ('${bookingId}','completed')`);
  const intent = await finance.claimPaymentIntent(db, { bookingId, customerId: `CUS-${bookingId}`, paymentId: `PAY-${bookingId}`, idempotencyKey: `IDEM-${bookingId}`, amountPaise: 20000, currency: "INR", environment: "sandbox" });
  await db.prepare(`INSERT INTO partner_earning_pending
    (id,booking_id,partner_id,payment_intent_id,gross_service_value_paise,platform_fee_paise,tds_paise,gst_paise,earning_paise,currency,status,created_at,updated_at)
    VALUES (?,?,?, ?,20000,3000,0,0,17000,'INR','PENDING',?,?)`)
    .bind(earningId, bookingId, `PARTNER-${bookingId}`, String(intent.id), Date.now(), Date.now()).run();
}

let loaded;
test.before(async () => { loaded = await loadFinance(); });
test.after(async () => { await loaded?.cleanup(); });

test("unresolved dispute freezes partner funds and emits no release", async () => {
  const db = await financeDb();
  try {
    await seedEarning(db, loaded.module, "BOOK-DISPUTE-OPEN", "PEP-DISPUTE-OPEN");
    db.sqlite.prepare("INSERT INTO booking_cancellation_cases (id,booking_id,status,requested_at) VALUES (?,?,?,?)").run("CASE-OPEN", "BOOK-DISPUTE-OPEN", "awaiting_finance", Date.now());
    await assert.rejects(() => loaded.module.releasePartnerEarning(db, { bookingId: "BOOK-DISPUTE-OPEN", releaseType: "completion" }), /frozen while a dispute is unresolved/);
    assert.equal(db.sqlite.prepare("SELECT state FROM partner_fund_custody WHERE booking_id=?").get("BOOK-DISPUTE-OPEN").state, "DISPUTED_FROZEN");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM partner_payable_released WHERE booking_id=?").get("BOOK-DISPUTE-OPEN").n, 0);
  } finally { db.close(); }
});

test("explicit no-refund arbitration authorizes exactly one release", async () => {
  const db = await financeDb();
  try {
    await seedEarning(db, loaded.module, "BOOK-DISPUTE-RESOLVED", "PEP-DISPUTE-RESOLVED");
    const now = Date.now();
    db.sqlite.prepare("INSERT INTO booking_cancellation_cases (id,booking_id,status,requested_at,finance_decision,finance_decision_by,finance_decision_at) VALUES (?,?,?,?,?,?,?)")
      .run("CASE-RESOLVED", "BOOK-DISPUTE-RESOLVED", "closed", now - 1000, "no_refund", "finance.checker@pawspace.in", now);
    const first = await loaded.module.releasePartnerEarning(db, { bookingId: "BOOK-DISPUTE-RESOLVED", releaseType: "completion" });
    const second = await loaded.module.releasePartnerEarning(db, { bookingId: "BOOK-DISPUTE-RESOLVED", releaseType: "completion" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(db.sqlite.prepare("SELECT state FROM partner_fund_custody WHERE booking_id=?").get("BOOK-DISPUTE-RESOLVED").state, "RELEASED");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM partner_payable_released WHERE booking_id=?").get("BOOK-DISPUTE-RESOLVED").n, 1);
  } finally { db.close(); }
});

test("refund arbitration cannot release the original partner amount", async () => {
  const db = await financeDb();
  try {
    await seedEarning(db, loaded.module, "BOOK-DISPUTE-REFUND", "PEP-DISPUTE-REFUND");
    const now = Date.now();
    db.sqlite.prepare("INSERT INTO booking_cancellation_cases (id,booking_id,status,requested_at,finance_decision,finance_decision_by,finance_decision_at) VALUES (?,?,?,?,?,?,?)")
      .run("CASE-REFUND", "BOOK-DISPUTE-REFUND", "closed", now - 1000, "refund_partial", "finance.checker@pawspace.in", now);
    await assert.rejects(() => loaded.module.releasePartnerEarning(db, { bookingId: "BOOK-DISPUTE-REFUND", releaseType: "completion" }), /requires financial reallocation/);
    assert.equal(db.sqlite.prepare("SELECT state FROM partner_fund_custody WHERE booking_id=?").get("BOOK-DISPUTE-REFUND").state, "ARBITRATION_REALLOCATION_REQUIRED");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM partner_payable_released WHERE booking_id=?").get("BOOK-DISPUTE-REFUND").n, 0);
  } finally { db.close(); }
});
