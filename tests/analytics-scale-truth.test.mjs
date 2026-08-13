/**
 * Analytics that turn a failed read into a clean-looking result.
 *
 * Two defects found by independent QA on main, both of the same shape - the query broke, nothing threw,
 * and the screen published a confident answer:
 *
 *   1. lib/company-analytics.ts:23-25 built three cost-ledger IN lists straight from the booking ids
 *      (boarding, sitting and training payouts), directly beneath a payments read that #158 had already
 *      chunked. Past D1's 100-bound-parameter cap the reads failed, safeAll swallowed them, and cost
 *      and margin silently vanished for the vertical while GMV and collected stayed correct. Worse than
 *      absent: costCoverage then reported 0% for a period in which every booking had a real payout row.
 *
 *   2. app/api/crm/route.ts published `lifetime_value_basis: "no_recognized_bookings"` - a positive
 *      claim that the bookings table was consulted and held nothing - whenever the read FAILED, because
 *      the basis was derived from the result rather than from whether the read returned.
 *
 * These execute the real modules against node:sqlite with a shim that enforces the same 100-parameter
 * cap production does. Both defects were invisible to the existing tests, which assert source strings.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SCALE_DB__", "__SCALE_ENV__");

/** D1 refuses a statement with more than 100 bound parameters. The cap is the point of these tests. */
const D1_MAX_BOUND_PARAMS = 100;

function makeD1(sqlite) {
  function statement(sql, args) {
    const guard = () => {
      if (args.length > D1_MAX_BOUND_PARAMS) throw new Error("D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR");
    };
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

const LEDGERS = {
  boarding: "CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT PRIMARY KEY,payout_amount REAL)",
  pet_sitting: "CREATE TABLE sitting_sitter_settlement_ledger (booking_id TEXT PRIMARY KEY,payout_amount REAL)",
  dog_training: "CREATE TABLE training_session_earnings (booking_id TEXT,gross_earning REAL,status TEXT)",
};

/** `count` bookings in one vertical, every one carrying a real, known cost. */
function seedVertical(serviceCode, count) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  sqlite.exec("CREATE TABLE booking_payments (booking_id TEXT,amount REAL,status TEXT,gateway TEXT)");
  sqlite.exec(LEDGERS[serviceCode]);
  for (let index = 0; index < count; index += 1) {
    const id = `BK${String(index).padStart(5, "0")}`;
    sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,'pkg','z1','PRV-1','completed',1000,'INR','2026-07-01T09:00:00.000Z','2026-07-02T09:00:00.000Z')").run(id, `CUS${index}`, serviceCode);
    sqlite.prepare("INSERT INTO booking_payments VALUES (?,1000,'captured','uat_sandbox')").run(id);
    if (serviceCode === "dog_training") sqlite.prepare("INSERT INTO training_session_earnings VALUES (?,600,'earned')").run(id);
    else sqlite.prepare(`INSERT INTO ${serviceCode === "boarding" ? "boarding_host_settlement_ledger" : "sitting_sitter_settlement_ledger"} VALUES (?,600)`).run(id);
  }
  globalThis.__SCALE_DB__ = makeD1(sqlite);
  globalThis.__SCALE_ENV__ = {};
  return globalThis.__SCALE_DB__;
}

for (const serviceCode of ["boarding", "pet_sitting", "dog_training"]) {
  test(`real execution: ${serviceCode} cost and margin survive more bookings than D1 allows bound parameters`, async () => {
    const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
    // 120 is past the cap and past one chunk, so it proves chunking rather than a bigger single query.
    const analytics = await buildCompanyAnalytics(seedVertical(serviceCode, 120));
    const line = analytics.services[serviceCode];

    assert.equal(line.gmv, 120000, "GMV was always right - which is why the missing cost looked healthy");
    assert.equal(line.costAmount, 120 * 600, "the real payout total is reported, not dropped");
    assert.equal(line.costCoverage, 1, "every booking has a payout row, so coverage is complete");
    assert.equal(line.marginPct, 40, "and the margin is a real number");
  });
}

test("real execution: cost coverage is never reported as zero while the payouts exist", async () => {
  // The precise old symptom: costCoverage 0 on a period where 100% of bookings had a payout row. A
  // reader cannot tell that from "cost genuinely not configured yet", which is why it survived.
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  for (const count of [80, 101, 240]) {
    const analytics = await buildCompanyAnalytics(seedVertical("boarding", count));
    const line = analytics.services.boarding;
    assert.equal(line.costCoverage, 1, `coverage must stay complete at ${count} bookings`);
    assert.equal(line.costAmount, count * 600, `cost must stay real at ${count} bookings`);
  }
});

test("real execution: the money reads survive the cap too, so the whole line is consistent", async () => {
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(seedVertical("boarding", 240));
  assert.equal(analytics.money.gmv, 240000);
  assert.equal(analytics.money.collected, 240000, "the chunked payments read from #158 still holds");
  assert.equal(analytics.services.boarding.marginAmount, 240000 - 240 * 600);
});

test("real execution: CRM never claims a customer has no bookings when it could not read them", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__SCALE_DB__ = makeD1(sqlite);
  globalThis.__SCALE_ENV__ = {};
  const route = await import("../app/api/crm/route.ts");
  // Cold database: the route's own ensureTables creates crm_contacts; canonical_bookings does not exist.
  await globalThis.__SCALE_DB__.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,lifetime_value,updated_at) VALUES ('C1','Meera Shah','+919000000001',4150,?)").run(Date.now());

  const response = await route.GET(new Request("http://localhost/api/crm"));
  const body = await response.json();
  const contact = body.contacts[0];

  assert.equal(response.status, 200, "one absent module must not take the CRM down");
  assert.equal(contact.lifetime_value_basis, "unavailable", "but it must not claim the bookings were read");
  assert.notEqual(contact.lifetime_value_basis, "no_recognized_bookings", "that is a positive claim a failed read cannot make");
  assert.equal(contact.lifetime_value, null, "and the figure is missing rather than a confident zero");
});

test("real execution: a customer with genuinely no bookings still reads as no recognised bookings", async () => {
  // The fix must not turn every empty customer into "unavailable" - the two states stay distinct.
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__SCALE_DB__ = makeD1(sqlite);
  globalThis.__SCALE_ENV__ = {};
  const route = await import("../app/api/crm/route.ts");
  await globalThis.__SCALE_DB__.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,total_amount REAL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,lifetime_value,updated_at) VALUES ('C1','Meera Shah','+919000000001',4150,?)").run(Date.now());
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,lifetime_value,updated_at) VALUES ('C2','Real Customer','+919000000002',0,?)").run(Date.now());
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK1','C2','completed',5000)").run();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK2','C2','cancelled',9000)").run();

  const body = await (await route.GET(new Request("http://localhost/api/crm"))).json();
  const byId = new Map(body.contacts.map((row) => [row.id, row]));

  assert.equal(byId.get("C1").lifetime_value, 0, "the read succeeded and found nothing");
  assert.equal(byId.get("C1").lifetime_value_basis, "no_recognized_bookings");
  assert.equal(byId.get("C2").lifetime_value, 5000, "cancelled bookings are still excluded");
  assert.equal(byId.get("C2").lifetime_value_basis, "recognized_bookings");
});

test("the CRM screen renders the unread state instead of a zero", async () => {
  const page = await (await import("node:fs/promises")).readFile(new URL("../app/crm/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Bookings could not be read/, "the screen names the state rather than printing a number");
  assert.match(page, /lifetime:row\.lifetime_value==null\?null:Number\(row\.lifetime_value\)/, "a null figure must not collapse to 0");
  assert.match(page, /\(c\.lifetime\?\?0\)>20000/, "an unread contact must not be segmented on a figure nobody has");
});
