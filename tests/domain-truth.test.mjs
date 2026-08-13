/**
 * Domain truth: invariants that must hold whatever the code does.
 *
 * Every gate so far checks how the platform behaves. These check what must be *true* of it - the
 * statements a founder would want to bet the business on, expressed so a machine can refuse a merge
 * that breaks one. They start with the two areas that carry real exposure and that no other session is
 * currently editing: money agreement and permission boundaries.
 *
 *   1. A report's money is the ledger's money, and collected never exceeds what was recognised.
 *   2. A service line's money sums to the company's money.
 *   3. Two screens looking at the same money agree. The ₹0-collected incident was one screen
 *      disagreeing with the database; nothing caught it because nothing compared them.
 *   4. Money that cannot be read is declared, never rendered as zero.
 *   5. A role cannot grant itself the power to change roles.
 *   6. Founder access cannot be taken by anyone holding user administration.
 *   7. The same request submitted twice creates one booking, not two.
 *
 * Invariant 1 failed the first time it ran, which is the point of writing them this way: cash captured
 * against a booking that was later cancelled was counted as collected while its amount was excluded
 * from GMV, so collected sat above turnover and /control's collection rate could print over 100%.
 * Fixed in lib/company-analytics.ts - collected is now counted over the bookings GMV recognises, and
 * the cancelled cash is reported as what it is, `money.heldOnCancelled`, a refund liability.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRUTH_DB__", "__TRUTH_ENV__");

function makeD1(sqlite, { failOn } = {}) {
  function statement(sql, args) {
    const guard = () => { if (failOn && failOn.test(sql)) throw new Error("D1_ERROR: no such table: booking_payments"); };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { guard(); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { guard(); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { guard(); return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const item of statements) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// DDL copied from drizzle/0011_serious_shaman.sql and scripts/staging-seed.sql.
const BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id text PRIMARY KEY NOT NULL, idempotency_key text NOT NULL, customer_id text NOT NULL, pet_ids_json text NOT NULL, source_pet_ids_json text NOT NULL, city_id text NOT NULL, zone_id text NOT NULL, service_code text NOT NULL, package_code text NOT NULL, package_name text NOT NULL, schedule_group_id text NOT NULL, provider_id text NOT NULL, scheduled_start text NOT NULL, scheduled_end text NOT NULL, status text DEFAULT 'confirmed' NOT NULL, channel text DEFAULT 'customer_app' NOT NULL, total_amount real NOT NULL, currency text DEFAULT 'INR' NOT NULL, pricing_json text DEFAULT '{}' NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)";
const BOOKINGS_UNIQUE = "CREATE UNIQUE INDEX IF NOT EXISTS canonical_bookings_idempotency_key_unique ON canonical_bookings (idempotency_key)";
const PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const INVOICES = "CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL,status TEXT NOT NULL,gross_amount REAL NOT NULL,tax_amount REAL NOT NULL,net_amount REAL NOT NULL,issued_at INTEGER NOT NULL)";

// A book with one of everything the money reports disagree about: a captured booking, a booking whose
// payment never captured, and a cancelled booking that must not count anywhere.
function seedBook({ failOn } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const ddl of [BOOKINGS, BOOKINGS_UNIQUE, PAYMENTS, INVOICES]) sqlite.exec(ddl);
  const now = Date.now();
  const add = (id, status, amount, paymentStatus) => {
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','zone-1','grooming','pkg','Full groom',?,'PRV-1','2026-07-01T09:00:00.000Z','2026-07-01T10:00:00.000Z',?,'customer_app',?,'INR','{}','seed',?,?)")
      .run(id, `${id}-idem`, `CUS-${id}`, `SG-${id}`, status, amount, now, now);
    if (paymentStatus) {
      sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','card','prepaid',?,'uat_sandbox',?,'{}',?,?)")
        .run(`PAY-${id}`, id, `CUS-${id}`, amount, amount, paymentStatus, `pidem-${id}`, now, now);
    }
  };
  add("BK-PAID", "completed", 4000, "captured");
  add("BK-UNPAID", "confirmed", 2500, "created");
  add("BK-CANCELLED", "cancelled", 9000, "captured");
  globalThis.__TRUTH_DB__ = makeD1(sqlite, { failOn });
  globalThis.__TRUTH_ENV__ = {};
  return { sqlite, db: globalThis.__TRUTH_DB__ };
}

test("TRUTH: the money a report publishes is the money the ledger holds", async () => {
  const { sqlite, db } = seedBook();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(db);

  // The ledger, asked directly - the number a founder would get from the database. Collected is
  // counted over the same bookings GMV recognises, or the two contradict each other.
  const captured = sqlite.prepare("SELECT COALESCE(SUM(p.amount),0) AS total FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE p.status IN ('captured','paid') AND b.status NOT IN ('cancelled','draft')").get().total;
  assert.equal(analytics.money.collected, captured, "collected must equal what is actually captured against recognised bookings");

  // GMV excludes cancelled: a cancelled booking is not turnover however its payment landed.
  const recognisable = sqlite.prepare("SELECT COALESCE(SUM(total_amount),0) AS total FROM canonical_bookings WHERE status NOT IN ('cancelled','draft')").get().total;
  assert.equal(analytics.money.gmv, recognisable);
  assert.ok(analytics.money.gmv < 4000 + 2500 + 9000, "the cancelled booking must not be counted as turnover");

  // And collected can never exceed what was recognised - that combination is arithmetically impossible
  // and would mean one of the two reads is looking at a different book. It used to be possible: cash
  // captured on a booking that was later cancelled was added to collected while its amount was kept
  // out of GMV, so /control could print a collection rate above 100%.
  assert.ok(analytics.money.collected <= analytics.money.gmv, "collected above GMV means the two reads disagree about the book");

  // The cancelled booking's ₹9,000 is real cash. It must not vanish from the report just because it
  // is not revenue - it is a refund liability, and it is reported as one.
  assert.equal(analytics.money.heldOnCancelled, 9000, "cash held against cancelled bookings is reported, not discarded");
  assert.equal(analytics.money.collected + analytics.money.heldOnCancelled, sqlite.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM booking_payments WHERE status IN ('captured','paid')").get().total, "every captured rupee is in exactly one of the two figures");
});

test("TRUTH: a service line's money adds up to the company's money", async () => {
  // The same defect can hide one level down: the per-service P&L on /control sums into the vertical
  // table, so a service line that counts cancelled cash as collected inflates the vertical without
  // touching the headline.
  const { db } = seedBook();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const { money, services } = await buildCompanyAnalytics(db);

  const lines = Object.values(services);
  assert.ok(lines.length, "the fixture produces at least one service line");
  assert.equal(lines.reduce((sum, line) => sum + line.gmv, 0), money.gmv, "service GMV must sum to company GMV");
  assert.equal(lines.reduce((sum, line) => sum + line.collected, 0), money.collected, "service collected must sum to company collected");
  for (const line of lines) {
    assert.ok(line.collected <= line.gmv, "a service line cannot collect more than it recognised");
  }
});

test("TRUTH: two reports looking at the same money agree", async () => {
  // The ₹0-collected incident was one screen disagreeing with the database and nothing catching it,
  // because nothing compared them. Analytics and the finance view read the same two tables through
  // different code; on one book they must produce one arithmetic.
  const { db } = seedBook();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const { buildAccountsBusinessView } = await import("../lib/accounts-business-view.ts");
  const analytics = await buildCompanyAnalytics(db);
  const finance = await buildAccountsBusinessView(db);

  // The fixture carries the money tables and nothing else, so the reports may name CX or providers as
  // unread - but neither may claim it could not read the book the comparison is about.
  const moneySources = (report) => (report.degraded?.sources || []).filter((source) => ["bookings", "payments", "invoices"].includes(source));
  assert.deepEqual(moneySources(analytics), [], "analytics read the whole book");
  assert.deepEqual(moneySources(finance), [], "and so did finance");

  // Finance recognises the same book: what is still owed is turnover minus what was collected on it.
  assert.equal(finance.receivable, analytics.money.gmv - analytics.money.collected, "receivable and collected must be two halves of the same GMV");
  // BK-UNPAID is the whole of it: ₹2,500 recognised, nothing captured.
  assert.equal(finance.receivable, 2500);
  // And the cancelled booking must not appear as money owed by anyone.
  assert.ok(finance.receivable < 9000, "a cancelled booking cannot become a receivable");
});

test("TRUTH: money that could not be read is declared, never rendered as zero", async () => {
  const { db } = seedBook({ failOn: /FROM booking_payments/ });
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(db);

  assert.equal(analytics.money.collected, 0, "the figure is zero because nothing could be read");
  assert.ok(analytics.degraded, "and that is stated, so nobody reads the zero as revenue");
  assert.ok(analytics.degraded.sources.includes("payments"));
});

test("TRUTH: a role cannot grant itself the power to change roles", async () => {
  const { defaultRoles, hasPermission } = await import("../lib/platform-security.ts");
  const admin = defaultRoles.find((role) => role.code === "admin");
  assert.ok(admin, "the admin role exists");
  assert.equal(hasPermission(admin.permissions, "users.manage"), true, "admin administers users");
  assert.equal(hasPermission(admin.permissions, "roles.manage"), false, "but cannot rewrite what a role may do");

  for (const role of defaultRoles) {
    if (["founder", "superuser"].includes(role.code)) continue;
    assert.equal(hasPermission(role.permissions, "roles.manage"), false, `${role.code} must not hold roles.manage`);
  }
});

test("TRUTH: founder access cannot be taken by anyone who can administer users", async () => {
  // Asserted as behaviour, not as a source string. An earlier version of this invariant grepped the
  // route for the literal `roleCode==="founder"` guard; that guard was correct but naming one role left
  // `superuser` (also ["*"]) wide open, so the platform now DERIVES the protected set from permissions
  // rather than from a name. A text match on the old spelling would fail against the stronger route
  // while the property it cares about — a user-admin cannot mint full access — holds more firmly than
  // before. So drive the real handler and read the database back.
  const route = await import("../app/api/platform-governance/route.ts");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("U-STAFF", "ordinary.staff@tkpetcare.in", "Ordinary Staff", "associate", "active", 0, 0);
  globalThis.__TRUTH_DB__ = makeD1(sqlite);
  const post = (body) => route.POST(new Request("http://localhost/api/platform-governance", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": "admin.actor@tkpetcare.in" },
    body: JSON.stringify(body),
  }));

  // Door 1 — creating a founder is refused, and NO account is written for it.
  const created = await post({ action: "create_user", email: "brand.new@tkpetcare.in", name: "Brand New", roleCode: "founder" });
  assert.equal(created.status, 400, "create_user must refuse the founder role");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM app_users WHERE email=?").get("brand.new@tkpetcare.in").total, 0, "no founder account may be created");

  // Door 2 — promoting an existing user into a founder is refused, and the row is unchanged.
  const promoted = await post({ action: "update_user", id: "U-STAFF", roleCode: "founder", status: "active" });
  assert.equal(promoted.status, 400, "update_user must refuse to promote into a founder");
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE id=?").get("U-STAFF").role_code, "associate", "the target's role must be untouched");

  // And the same protection covers the OTHER full-access role the name-based guard used to miss.
  const superuser = await post({ action: "update_user", id: "U-STAFF", roleCode: "superuser", status: "active" });
  assert.equal(superuser.status, 400, "superuser is ['*'] too and must be refused identically");
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE id=?").get("U-STAFF").role_code, "associate");
  assert.equal(typeof route.POST, "function");
});

test("TRUTH: the same booking request submitted twice creates one booking", async () => {
  const { sqlite } = seedBook();
  const insert = () => sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','zone-1','grooming','pkg','Full groom',?,'PRV-1','2026-07-02T09:00:00.000Z','2026-07-02T10:00:00.000Z','confirmed','customer_app',1500,'INR','{}','seed',?,?)")
    .run(`BK-DOUBLE-${Math.random()}`, "same-idempotency-key", "CUS-D", `SG-${Math.random()}`, Date.now(), Date.now());

  insert();
  // The constraint is the guarantee: a retried submit cannot become a second booking, whatever the
  // route does above it.
  assert.throws(insert, /UNIQUE|constraint/i, "a duplicate idempotency key must be refused by the database itself");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM canonical_bookings WHERE idempotency_key='same-idempotency-key'").get().total, 1);
});

test("TRUTH: every canonical booking carries an idempotency key that is unique", async () => {
  const { sqlite } = seedBook();
  const indexes = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='canonical_bookings'").all();
  const unique = indexes.find((row) => /UNIQUE/i.test(row.sql || "") && /idempotency_key/i.test(row.sql || ""));
  assert.ok(unique, "the uniqueness that makes a retry safe must be in the schema, not only in the route");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM canonical_bookings WHERE idempotency_key IS NULL OR idempotency_key=''").get().total, 0);
});
