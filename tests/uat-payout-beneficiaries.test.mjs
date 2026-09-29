/*
 * Package E (27 Sept 2026): payouts must be testable end to end on staging - queue -> Release -> Send TEST payout ->
 * RazorpayX TEST webhook -> processed - with no live money anywhere. The staging seeds created no payout beneficiary
 * for the UAT roster, so every seeded groomer's payout stopped at "No verified bank account for this provider".
 *
 * Everything here EXECUTES the real modules on the in-memory harness: the UAT gate and map parser, the self-heal, the
 * payout queue sweep and release, the RazorpayX TEST dispatch against a loopback provider, the partner-finance route
 * and the assignment eligibility engine. Modules are imported inside the test that needs them, so on the base commit
 * the behaviour tests fail on behaviour (a refused release, a blocked groomer, a missing readiness line).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__UAT_PAYOUT_DB__", "__UAT_PAYOUT_ENV__");
process.env.FORBID_PRODUCTION = "true";

// Every console line written while these tests run is kept, so the last test can prove no secret reached a log.
const logged = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")); original(...args); };
}

const DAY = 86_400_000;
const KEY = "rzp_test_uat", SECRET = "sandbox-secret", ACCOUNT = "000000000001", WEBHOOK = "hook-secret", FA = "fa_uatseed1", CONT = "cont_uatseed1";
const SECRETS = [KEY, SECRET, ACCOUNT, WEBHOOK, FA, CONT];
const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const UAT = { ...SANDBOX, PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_RAZORPAYX_ENV: "sandbox", PAWSPACE_RAZORPAYX_LIVE_APPROVED: "false", RAZORPAYX_KEY_ID_SANDBOX: KEY, RAZORPAYX_KEY_SECRET_SANDBOX: SECRET, RAZORPAYX_ACCOUNT_NUMBER_SANDBOX: ACCOUNT, RAZORPAYX_WEBHOOK_SECRET_SANDBOX: WEBHOOK, RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX: JSON.stringify({ uatcap_groom_south: { fund_account_id: FA, contact_id: CONT } }) };
// The gate is on but RazorpayX TEST is not ready (no webhook secret): a release never reaches the network here.
const UAT_NOT_READY = { ...UAT, RAZORPAYX_WEBHOOK_SECRET_SANDBOX: "" };
const PRODUCTION_LIKE = { ...SANDBOX, PAWSPACE_DEPLOYMENT_ENV: "production", PAWSPACE_RAZORPAYX_ENV: "sandbox", PAWSPACE_RAZORPAYX_LIVE_APPROVED: "false", RAZORPAYX_KEY_ID_SANDBOX: KEY };
// Route tests leave PAWSPACE_DEPLOYMENT_ENV unset: on a deployed runtime the harness's header identity is not trusted
// (lib/trusted-workspace-identity.ts), and the gate only needs it to not say "production".
const withoutDeployment = (env) => { const copy = { ...env }; delete copy.PAWSPACE_DEPLOYMENT_ENV; return copy; };
const ROUTE_UAT = withoutDeployment(UAT), ROUTE_UAT_NOT_READY = withoutDeployment(UAT_NOT_READY), ROUTE_PLAIN = withoutDeployment(PRODUCTION_LIKE);
const FINANCE = "anjali.finance@pawspace.test";
const GROOMER = "uatcap_groom_south";
const SEED_TABLES = ["provider_compensation_profiles", "provider_onboarding_applications", "provider_verifications", "provider_onboarding_events"];

function payoutWorld(env = UAT) {
  const { sqlite, db } = world("__UAT_PAYOUT_DB__", "__UAT_PAYOUT_ENV__", env);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE unified_cases (id TEXT PRIMARY KEY,case_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',title TEXT NOT NULL,booking_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,provider_model TEXT,services_json TEXT,zones_json TEXT,live INTEGER,status TEXT,updated_by TEXT,updated_at INTEGER);
  `);
  return { sqlite, db };
}
/** A roster row as scripts/uat-staging-provider-capacity.sql writes it: founder_seed provenance, full_time in the capacity profile. */
const roster = (sqlite, id, updatedBy = "founder_seed") => sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES (?,'blr',?,'full_time','[\"grooming\"]','[\"blr-south\"]',1,'active',?,?)").run(id, id, updatedBy, Date.now());
const iso = (at) => new Date(at).toISOString().slice(0, 10);
/** A completed commission booking whose completion journal credited 2110-Provider Payable, as the completion engines post it. */
async function completedBooking(sqlite, db, { id, providerId, total = 1000, payable = 700, gst = 54, completedAt = Date.now() - 8 * DAY }) {
  const accounts = await import("../lib/finance-accounts.ts");
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,'CUS-UAT','blr','grooming',?,'completed',?,'INR',?,?)").run(id, providerId, total, completedAt, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,'commission','grooming','completed',?,?)").run(`WO-${id}`, id, providerId, completedAt, now);
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,actor_id,occurred_at) VALUES (?,?,'booking_completed','provider',?)").run(`EV-${id}`, id, completedAt);
  await accounts.postJournal(db, {
    groupKey: `TEST-COMPLETION-${id}`, entryDate: iso(completedAt), periodCode: iso(completedAt).slice(0, 7), sourceType: "service_completion", sourceId: id,
    narration: `Service completion ${id}`, metadata: { bookingId: id },
    lines: [{ accountCode: "2230-Customer Collections", debit: total }, { accountCode: "2110-Provider Payable", credit: payable }, { accountCode: "2130-GST Payable", credit: gst }, { accountCode: "4000-Service Revenue", credit: Math.round((total - payable - gst) * 100) / 100 }],
  });
}
/** A provider who is NOT on the UAT roster and already has the three records, written through the real ensure functions. */
async function verifiedRealProvider(sqlite, db, providerId) {
  const commission = await import("../lib/provider-commission-governance.ts"), onboarding = await import("../lib/provider-onboarding-transactional.ts"), mandate = await import("../lib/provider-verification-mandate.ts");
  await commission.ensureProviderCommissionTables(db); await onboarding.ensureProviderOnboardingTransactional(db); await mandate.ensureVerificationMandateTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission','cont_REAL1','fa_REAL0001','active','Bank account saved by Finance','ops@pawspace.test',?,?)").run(providerId, now, now);
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,status,locale_code,basic_info_json,created_by,created_at,updated_at) VALUES (?,?,'grooming','IN','approved','en','{}','ops@pawspace.test',?,?)").run(`APP-${providerId}`, providerId, now, now);
  sqlite.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,detail_json,verified_at,updated_by,created_at,updated_at) VALUES (?,?,'groomer','bank_kyc','verified',0,'{}',?,'ops@pawspace.test',?,?)").run(`VER-${providerId}`, `APP-${providerId}`, now, now, now);
}
const item = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_payout_queue_items WHERE booking_id=?").get(bookingId);
const payout = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_order_payouts WHERE booking_id=?").get(bookingId);
const tableNames = (sqlite) => new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
const dump = (sqlite) => JSON.stringify(SEED_TABLES.map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
/** node:sqlite rows carry a null prototype; deepEqual wants plain objects. */
const plain = (row) => (row ? { ...row } : row);

/** A loopback RazorpayX TEST stand-in: the client only ever talks to it under PAWSPACE_RAZORPAYX_CONTRACT_TEST. */
async function loopbackRazorpayX({ failWith = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}; calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (failWith && req.method === "POST" && req.url === "/v1/payouts") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: failWith } })); return; }
      if (req.method === "POST" && req.url === "/v1/payouts") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "pout_UATTEST001", entity: "payout", fund_account_id: body.fund_account_id, amount: body.amount, currency: "INR", status: "processing", reference_id: body.reference_id, utr: null })); return; }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the fund account map is read in every form the sandbox script accepts, and never throws", async () => {
  const { parseUatFundAccountMap, uatBeneficiaryFor, UAT_SEED_CONTACT_ID } = await import("../lib/uat-payout-beneficiaries.ts");
  const keyed = parseUatFundAccountMap(JSON.stringify({ uatcap_groom_south: { fund_account_id: "fa_south1", contact_id: "cont_south1" }, uatcap_groom_east: "fa_east22" }));
  assert.deepEqual([keyed.fundAccounts, keyed.contacts], [["fa_south1", "fa_east22"], ["cont_south1"]]);
  assert.deepEqual(uatBeneficiaryFor(keyed, "uatcap_groom_south"), { fundAccountId: "fa_south1", contactId: "cont_south1" }, "a provider-keyed map is honoured");
  assert.deepEqual(uatBeneficiaryFor(keyed, "uatcap_groom_east"), { fundAccountId: "fa_east22", contactId: UAT_SEED_CONTACT_ID });
  assert.deepEqual(uatBeneficiaryFor(keyed, "groom_arun"), { fundAccountId: "fa_south1", contactId: UAT_SEED_CONTACT_ID }, "an unmapped groomer takes the first fund account");
  const array = parseUatFundAccountMap('["fa_a1","cont_c1","not-an-id"]');
  assert.deepEqual([array.fundAccounts, array.contacts], [["fa_a1"], ["cont_c1"]]);
  assert.deepEqual(uatBeneficiaryFor(array, "anyone"), { fundAccountId: "fa_a1", contactId: "cont_c1" }, "one fund account and one contact pair up");
  const tokens = parseUatFundAccountMap("fa_a, fa_b;fa_a\ncont_z");
  assert.deepEqual([tokens.fundAccounts, tokens.contacts], [["fa_a", "fa_b"], ["cont_z"]]);
  assert.deepEqual(uatBeneficiaryFor(tokens, "anyone"), { fundAccountId: "fa_a", contactId: UAT_SEED_CONTACT_ID }, "two fund accounts and one contact do not pair");
  const generic = parseUatFundAccountMap('{"fundAccounts":["fa_g1"],"contacts":["cont_g1"]}');
  assert.deepEqual([generic.fundAccounts, generic.contacts], [["fa_g1"], ["cont_g1"]]);
  for (const raw of ["", null, undefined, "{not json", '{"a":1}', 42]) assert.deepEqual(parseUatFundAccountMap(raw).fundAccounts, [], String(raw));
  assert.equal(uatBeneficiaryFor(parseUatFundAccountMap(""), "anyone"), null);
});

test("the gate is on only for a declared UAT runtime whose RazorpayX is TEST-only and which is not production", async () => {
  const { uatPayoutBeneficiaryGate } = await import("../lib/uat-payout-beneficiaries.ts");
  assert.equal(uatPayoutBeneficiaryGate(UAT), true);
  assert.equal(uatPayoutBeneficiaryGate(UAT_NOT_READY), true, "the gate needs the TEST key, not the webhook secret");
  const off = [{ ...UAT, PAWSPACE_SCHEDULING_ENV: undefined }, { ...UAT, PAWSPACE_SCHEDULING_ENV: "production" }, { ...UAT, PAWSPACE_RAZORPAYX_ENV: "live" }, { ...UAT, PAWSPACE_RAZORPAYX_LIVE_APPROVED: "true" }, { ...UAT, RAZORPAYX_KEY_ID_SANDBOX: "rzp_live_ABC123" }, { ...UAT, RAZORPAYX_KEY_ID_SANDBOX: "" }, { ...UAT, PAWSPACE_DEPLOYMENT_ENV: "production" }, { ...UAT, PAWSPACE_RAZORPAYX_LIVE_APPROVED: "yes" }, { ...UAT, PAWSPACE_RAZORPAYX_LIVE_APPROVED: undefined }, PRODUCTION_LIKE, SANDBOX, {}, null, undefined];
  for (const env of off) assert.equal(uatPayoutBeneficiaryGate(env), false, JSON.stringify(env));
  assert.equal(uatPayoutBeneficiaryGate(new Proxy({}, { get() { throw new Error("boom"); } })), false, "never throws");
});

test("under the UAT gate the seeded groomer is given a payout beneficiary once; a person's profile and a real provider are untouched", async () => {
  const { sqlite, db } = payoutWorld();
  for (const id of [GROOMER, "uatcap_groom_north", "uatcap_groom_west"]) roster(sqlite, id);
  roster(sqlite, "PRV-REAL-1", "ops@pawspace.test");
  const seeds = await import("../lib/uat-payout-beneficiaries.ts"), beneficiary = await import("../lib/payout-beneficiary-verification.ts"), commission = await import("../lib/provider-commission-governance.ts");
  await commission.ensureProviderCommissionTables(db);
  const now = Date.now();
  // A profile Finance saved by hand with the provider's own TEST account, and one Finance saved with no account at all.
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES ('uatcap_groom_north','commission','cont_PERSON','fa_PERSONOWN1','active','Saved by Finance','anjali.finance33@tkpetcare.in',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES ('uatcap_groom_west','commission',NULL,NULL,'active','Saved by Finance','anjali.finance33@tkpetcare.in',?,?)").run(now, now);
  const personRow = (id) => plain(sqlite.prepare("SELECT provider_id,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,updated_at FROM provider_compensation_profiles WHERE provider_id=?").get(id));
  const northBefore = personRow("uatcap_groom_north");

  const first = await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER, "uatcap_groom_north", "uatcap_groom_west", "PRV-REAL-1"], now });
  assert.equal(first.enabled, true);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.healed.sort(), ["uatcap_groom_north", GROOMER, "uatcap_groom_west"]);
  assert.deepEqual(first.skipped.map((s) => s.providerId), ["PRV-REAL-1"]);
  assert.match(first.skipped[0].reason, /Not a seeded UAT roster provider/);

  const verified = await beneficiary.preauthorizeVerifiedPayoutBeneficiary(db, { providerId: GROOMER, scopeType: "booking", scopeId: "BK-SEED", asOf: now });
  assert.equal(verified.razorpayxFundAccountId, FA, "the mapped TEST fund account");
  assert.equal(verified.razorpayxContactId, CONT);
  const north = await beneficiary.preauthorizeVerifiedPayoutBeneficiary(db, { providerId: "uatcap_groom_north", scopeType: "booking", scopeId: "BK-NORTH", asOf: now });
  assert.equal(north.razorpayxFundAccountId, "fa_PERSONOWN1", "the person's own account is what gets paid");
  assert.deepEqual(personRow("uatcap_groom_north"), northBefore, "a profile a person saved WITH bank details is not changed");
  const west = await beneficiary.preauthorizeVerifiedPayoutBeneficiary(db, { providerId: "uatcap_groom_west", scopeType: "booking", scopeId: "BK-WEST", asOf: now });
  assert.equal(west.razorpayxFundAccountId, FA, "a person's profile with NO bank details gets the TEST bindings");
  const westRow = personRow("uatcap_groom_west");
  assert.deepEqual([westRow.updated_by, westRow.reason, westRow.razorpayx_contact_id, westRow.razorpayx_fund_account_id], ["anjali.finance33@tkpetcare.in", "Saved by Finance", CONT, FA], "and keeps who saved it and why");

  assert.deepEqual(plain(sqlite.prepare("SELECT engagement_model,status,updated_by,razorpayx_contact_id,razorpayx_fund_account_id FROM provider_compensation_profiles WHERE provider_id=?").get(GROOMER)), { engagement_model: "commission", status: "active", updated_by: "founder_seed", razorpayx_contact_id: CONT, razorpayx_fund_account_id: FA });
  const application = plain(sqlite.prepare("SELECT id,vertical_key,status,created_by,human_decision,verification_status FROM provider_onboarding_applications WHERE provider_id=?").get(GROOMER));
  assert.deepEqual(application, { id: `POAPP-UAT-${GROOMER}`, vertical_key: "uat_payout_seed", status: "uat_payout_seed", created_by: "founder_seed", human_decision: "uat_payout_seed", verification_status: "not_started" });
  assert.deepEqual(sqlite.prepare("SELECT status,expires_at,updated_by FROM provider_verifications WHERE application_id=? AND verification_type='bank_kyc'").all(application.id).map(plain), [{ status: "verified", expires_at: null, updated_by: "founder_seed" }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_onboarding_events WHERE event_type='uat_payout_beneficiary_seeded'").get().n, 3, "one event per provider healed");
  for (const table of ["provider_compensation_profiles", "provider_onboarding_applications"]) assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE provider_id='PRV-REAL-1'`).get().n, 0, `${table}: a real provider is never seeded`);
  const details = sqlite.prepare("SELECT detail_json FROM provider_onboarding_events").all().map((row) => row.detail_json).join(" ");
  for (const secret of [FA, CONT]) assert.ok(!details.includes(secret), "the event names what was seeded, not the ids");

  const before = dump(sqlite);
  const second = await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER, "uatcap_groom_north", "uatcap_groom_west", "PRV-REAL-1"], now: now + 60_000 });
  assert.deepEqual(second.healed, []);
  assert.deepEqual(second.unchanged.sort(), ["uatcap_groom_north", GROOMER, "uatcap_groom_west"]);
  assert.equal(dump(sqlite), before, "a second run writes nothing");
  // A run that stopped after healing the rows but before its events: a later run records the missing events once.
  sqlite.prepare("DELETE FROM provider_onboarding_events WHERE event_type='uat_payout_beneficiary_seeded'").run();
  await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER, "uatcap_groom_north", "uatcap_groom_west", "PRV-REAL-1"], now: now + 120_000 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_onboarding_events WHERE event_type='uat_payout_beneficiary_seeded'").get().n, 3, "each missing event recorded");
  const recovered = dump(sqlite);
  await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER, "uatcap_groom_north", "uatcap_groom_west", "PRV-REAL-1"], now: now + 180_000 });
  assert.equal(dump(sqlite), recovered, "and only once");
});

test("a seed profile keeps a fund account that already looks real, and the roster scan finds the seeded ids and the runtime defaults only", async () => {
  const { sqlite, db } = payoutWorld();
  roster(sqlite, GROOMER); roster(sqlite, "uatcap_groom_east"); roster(sqlite, "PRV-REAL-1", "ops@pawspace.test");
  const seeds = await import("../lib/uat-payout-beneficiaries.ts"), commission = await import("../lib/provider-commission-governance.ts");
  await commission.ensureProviderCommissionTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES ('uatcap_groom_east','commission',NULL,'fa_EASTREAL77','active','earlier seed','founder_seed',?,?)").run(now, now);
  const scan = await seeds.ensureUatPayoutBeneficiaries(db, UAT, { now });
  assert.ok(scan.providers.includes(GROOMER) && scan.providers.includes("uatcap_groom_east") && scan.providers.includes("groom_arun"), JSON.stringify(scan.providers));
  assert.ok(!scan.providers.includes("PRV-REAL-1"));
  assert.deepEqual(scan.errors, []);
  // The map holds one fund account and one contact, so they pair up for every unmapped groomer; the differing account itself is kept.
  assert.deepEqual(plain(sqlite.prepare("SELECT razorpayx_fund_account_id,razorpayx_contact_id FROM provider_compensation_profiles WHERE provider_id='uatcap_groom_east'").get()), { razorpayx_fund_account_id: "fa_EASTREAL77", razorpayx_contact_id: CONT }, "the existing account is kept and only the missing contact is filled");
  assert.equal(sqlite.prepare("SELECT razorpayx_fund_account_id FROM provider_compensation_profiles WHERE provider_id='groom_arun'").get().razorpayx_fund_account_id, FA, "an unmapped default groomer takes the first fund account");
});

test("with the gate off nothing is written, not even the tables", async () => {
  const seeds = await import("../lib/uat-payout-beneficiaries.ts");
  for (const env of [{ ...UAT, PAWSPACE_SCHEDULING_ENV: undefined }, { ...UAT, PAWSPACE_DEPLOYMENT_ENV: "production" }, { ...UAT, RAZORPAYX_KEY_ID_SANDBOX: "rzp_live_ABC123" }, { ...UAT, PAWSPACE_RAZORPAYX_LIVE_APPROVED: "true" }, PRODUCTION_LIKE, SANDBOX]) {
    const { sqlite, db } = payoutWorld(env);
    roster(sqlite, GROOMER);
    const result = await seeds.ensureUatPayoutBeneficiaries(db, env, { providerIds: [GROOMER] });
    assert.deepEqual([result.enabled, result.reason, result.healed], [false, "not_uat_test_runtime", []], JSON.stringify(env));
    const scan = await seeds.ensureUatPayoutBeneficiaries(db, env, {});
    assert.equal(scan.enabled, false);
    for (const table of SEED_TABLES) assert.ok(!tableNames(sqlite).has(table), `${table} must not exist: ${JSON.stringify(env)}`);
  }
});

test("the payout queue sweep heals a seeded groomer as it assesses the booking, so the booking is queued instead of waiting on a bank account", async () => {
  const { sqlite, db } = payoutWorld(UAT_NOT_READY);
  roster(sqlite, GROOMER);
  const queue = await import("../lib/provider-payout-queue.ts");
  await completedBooking(sqlite, db, { id: "BK-UAT-SWEEP", providerId: GROOMER });
  const off = await queue.runProviderPayoutQueueSweep(db, { force: true, env: SANDBOX });
  assert.deepEqual(off.errors, []);
  assert.equal("uatBeneficiaries" in off, false, "outside the gate the sweep does not even carry the UAT summary key");
  assert.equal(item(sqlite, "BK-UAT-SWEEP"), undefined);
  assert.equal(sqlite.prepare("SELECT reason FROM provider_payout_candidates WHERE booking_id='BK-UAT-SWEEP'").get().reason, "no_beneficiary", "production behaviour: no bank account, no queue entry");

  const on = await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  assert.deepEqual(on.errors, []);
  assert.deepEqual(on.uatBeneficiaries, { healed: [GROOMER], failed: [] });
  assert.equal(on.queued, 1);
  const queued = item(sqlite, "BK-UAT-SWEEP");
  assert.equal(queued.status, "awaiting_release");
  assert.equal(queued.blocked_reason, null);
  assert.equal(Number(queued.amount), 700);
  const again = await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  assert.deepEqual(again.uatBeneficiaries, { healed: [], failed: [] }, "nothing left to heal");
});

test("Release: refused for a seeded groomer without a bank account outside the gate; released with the TEST fund account under it, saying why the TEST payout was not sent", async () => {
  const { sqlite, db } = payoutWorld(UAT_NOT_READY);
  roster(sqlite, GROOMER);
  const queue = await import("../lib/provider-payout-queue.ts");
  await completedBooking(sqlite, db, { id: "BK-UAT-REL", providerId: GROOMER });
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  assert.equal(item(sqlite, "BK-UAT-REL").status, "awaiting_release");
  // The groomer's bank KYC disappears (as it was for every seeded groomer before this change).
  sqlite.prepare("DELETE FROM provider_verifications WHERE verification_type='bank_kyc'").run();

  const refused = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-REL"], actor: FINANCE, env: SANDBOX });
  assert.equal(refused.released.length, 0);
  assert.match(refused.refused[0].error, /^No verified bank account for this provider/);
  assert.equal(item(sqlite, "BK-UAT-REL").blocked_reason, "no_beneficiary");
  assert.equal(payout(sqlite, "BK-UAT-REL"), undefined);
  assert.equal("uatSelfHeal" in refused, false, "the production response shape is unchanged");

  const released = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-REL"], actor: FINANCE, env: UAT_NOT_READY });
  assert.deepEqual(released.refused, []);
  assert.equal(released.uatSelfHeal, true);
  const [done] = released.released;
  assert.equal(done.beneficiaryHealed, true);
  assert.equal(done.amount, 700);
  assert.deepEqual(done.dispatch, { attempted: false, connected: false, reason: "RazorpayX TEST is not configured: RAZORPAYX_WEBHOOK_SECRET_SANDBOX is required before any TEST payout dispatch" });
  const record = payout(sqlite, "BK-UAT-REL");
  assert.equal(record.status, "queued_sandbox", "left for Send TEST payout");
  assert.equal(record.razorpayx_fund_account_id, FA);
  assert.equal(record.razorpayx_contact_id, CONT);
  assert.ok(record.beneficiary_snapshot_sha256);
  assert.equal(item(sqlite, "BK-UAT-REL").status, "released");
  assert.equal(sqlite.prepare("SELECT status FROM provider_verifications WHERE verification_type='bank_kyc'").get().status, "verified", "the bank KYC row was seeded again");
});

test("under the gate with RazorpayX TEST ready, the same click sends the TEST payout to the (loopback) provider and records its payout id", async () => {
  const provider = await loopbackRazorpayX();
  try {
    const env = { ...UAT, PAWSPACE_RAZORPAYX_CONTRACT_TEST: "true", PAWSPACE_RAZORPAYX_API_BASE_URL: provider.url };
    const { sqlite, db } = payoutWorld(env);
    roster(sqlite, GROOMER);
    const queue = await import("../lib/provider-payout-queue.ts");
    await completedBooking(sqlite, db, { id: "BK-UAT-SEND", providerId: GROOMER });
    await queue.runProviderPayoutQueueSweep(db, { force: true, env });
    const released = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-SEND"], actor: FINANCE, reason: "UAT payout run", env });
    assert.deepEqual(released.refused, []);
    const [done] = released.released;
    assert.deepEqual(done.dispatch, { attempted: true, connected: true, providerPayoutId: "pout_UATTEST001", providerStatus: "processing", duplicatePrevented: false, reconciliationRequired: false, accounting: { status: "awaiting_provider", reason: null, principalOnly: true, bankStatementReconciled: false } });
    assert.equal(provider.calls.length, 1, "one TEST payout create call");
    assert.equal(provider.calls[0].body.fund_account_id, FA);
    assert.equal(provider.calls[0].body.amount, 70000, "Rs 700 in paise");
    assert.equal(provider.calls[0].body.account_number, ACCOUNT);
    assert.equal(provider.calls[0].body.notes.pawspace_environment, "sandbox");
    const record = payout(sqlite, "BK-UAT-SEND");
    assert.equal(record.status, "provider_processing_sandbox");
    assert.equal(record.provider_reference, "pout_UATTEST001");
    assert.equal(sqlite.prepare("SELECT provider_payout_id,provider_status FROM razorpayx_payout_provider_state WHERE local_payout_id=?").get(done.payoutId).provider_payout_id, "pout_UATTEST001");
    const dashboard = await queue.getProviderPayoutQueueDashboard(db, { uatSelfHeal: true });
    assert.equal(dashboard.queue.find((row) => row.booking_id === "BK-UAT-SEND").statusLabel, "Released, sent to RazorpayX TEST, processing");

    // A second click reports the same release and the same provider payout, and sends nothing twice.
    const again = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-SEND"], actor: FINANCE, env });
    assert.equal(again.released[0].duplicatePrevented, true);
    assert.equal(again.released[0].dispatch.duplicatePrevented, true);
    assert.equal(again.released[0].dispatch.providerPayoutId, "pout_UATTEST001");
    assert.equal(provider.calls.length, 1);
  } finally { await provider.close(); }
});

test("production is unchanged: a verified real provider is released the same way, with no dispatch and no UAT fields, and a real provider is never healed", async () => {
  const { sqlite, db } = payoutWorld(PRODUCTION_LIKE);
  const queue = await import("../lib/provider-payout-queue.ts");
  await verifiedRealProvider(sqlite, db, "PRV-REAL-1");
  await completedBooking(sqlite, db, { id: "BK-REAL-1", providerId: "PRV-REAL-1" });
  await completedBooking(sqlite, db, { id: "BK-REAL-2", providerId: "PRV-REAL-2" });
  const run = await queue.runProviderPayoutQueueSweep(db, { force: true, env: PRODUCTION_LIKE });
  assert.deepEqual(run.errors, []);
  assert.equal("uatBeneficiaries" in run, false, "the production sweep answer has no UAT key");
  assert.equal(item(sqlite, "BK-REAL-1").status, "awaiting_release");
  assert.equal(sqlite.prepare("SELECT reason FROM provider_payout_candidates WHERE booking_id='BK-REAL-2'").get().reason, "no_beneficiary");
  const before = dump(sqlite);
  const released = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REAL-1", "BK-REAL-2"], actor: FINANCE, env: PRODUCTION_LIKE });
  assert.equal(released.released.length, 1);
  assert.equal("dispatch" in released.released[0], false);
  assert.equal("beneficiaryHealed" in released.released[0], false);
  assert.equal("uatSelfHeal" in released, false);
  assert.equal(payout(sqlite, "BK-REAL-1").status, "queued_sandbox", "the two explicit steps stay: Release, then Send TEST payout");
  assert.equal(payout(sqlite, "BK-REAL-1").razorpayx_fund_account_id, "fa_REAL0001");
  assert.match(released.refused[0].error, /no payout waiting in the queue/);
  assert.equal(dump(sqlite), before, "the beneficiary tables are exactly as they were");
  // Even under the gate a provider that is not on the UAT roster is never given a beneficiary.
  const uat = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REAL-2"], actor: FINANCE, env: UAT_NOT_READY });
  assert.equal(uat.released.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_compensation_profiles WHERE provider_id='PRV-REAL-2'").get().n, 0);
});

test("the seeded application does not change the groomer's assignment eligibility", async () => {
  const { sqlite, db } = payoutWorld();
  roster(sqlite, GROOMER);
  const seeds = await import("../lib/uat-payout-beneficiaries.ts"), eligibility = await import("../lib/provider-assignment-eligibility.ts");
  const before = await eligibility.providerAssignmentBlock(db, GROOMER);
  assert.deepEqual([before.blocked, before.reasons], [false, ["uat_seed_fixture_exemption"]]);
  await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER] });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_onboarding_applications WHERE provider_id=?").get(GROOMER).n, 1);
  const after = await eligibility.providerAssignmentBlock(db, GROOMER);
  assert.deepEqual([after.blocked, after.reasons], [before.blocked, before.reasons], "still the roster fixture, not a provider failing an identity mandate");
  const profiles = new Map([[GROOMER, { id: GROOMER, services_json: '["grooming"]', updated_by: "founder_seed" }]]);
  const shortlist = await eligibility.filterAssignableProviders(db, [{ id: GROOMER }], Date.now(), profiles);
  assert.deepEqual(shortlist.map((p) => p.id), [GROOMER], "the matcher's shortlist path agrees");
});

test("the partner-finance route reports RazorpayX TEST readiness as booleans and problems only, never values", async () => {
  const { sqlite, db } = payoutWorld(ROUTE_UAT);
  await seedActors(sqlite, db, [{ id: "USR-UAT-FIN", email: FINANCE, role: "finance" }]);
  const route = await import("../app/api/partner-finance/route.ts");
  const read = await route.GET(asActor(FINANCE, "/api/partner-finance"));
  assert.equal(read.status, 200, await read.clone().text());
  const raw = await read.text(), data = JSON.parse(raw).data;
  assert.deepEqual(data.razorpayxTest, { ready: true, problems: [], keyIdConfigured: true, accountNumberConfigured: true, webhookSecretConfigured: true, fundAccountMapConfigured: true, uatSelfHeal: true });
  assert.equal(data.payoutQueue.policy.uatSelfHeal, true);
  for (const secret of SECRETS) assert.ok(!raw.includes(secret), `the payload must not carry ${secret.slice(0, 4)}...`);

  const notReady = payoutWorld({ ...ROUTE_UAT_NOT_READY, RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX: "" });
  await seedActors(notReady.sqlite, notReady.db, [{ id: "USR-UAT-FIN", email: FINANCE, role: "finance" }]);
  const partial = JSON.parse(await (await route.GET(asActor(FINANCE, "/api/partner-finance"))).text()).data.razorpayxTest;
  assert.deepEqual(partial, { ready: false, problems: ["RAZORPAYX_WEBHOOK_SECRET_SANDBOX is required before any TEST payout dispatch"], keyIdConfigured: true, accountNumberConfigured: true, webhookSecretConfigured: false, fundAccountMapConfigured: false, uatSelfHeal: true });

  const production = payoutWorld(ROUTE_PLAIN);
  await seedActors(production.sqlite, production.db, [{ id: "USR-UAT-FIN", email: FINANCE, role: "finance" }]);
  const closed = JSON.parse(await (await route.GET(asActor(FINANCE, "/api/partner-finance"))).text()).data;
  assert.equal(closed.razorpayxTest.uatSelfHeal, false);
  assert.equal(closed.razorpayxTest.ready, false);
  assert.equal(closed.payoutQueue.policy.uatSelfHeal, false);
});

test("Finance sees a seeded groomer's missing bank account as releasable with the staging note, and the route's click heals, releases and audits it", async () => {
  const { sqlite, db } = payoutWorld(ROUTE_UAT_NOT_READY);
  await seedActors(sqlite, db, [{ id: "USR-UAT-FIN", email: FINANCE, role: "finance" }]);
  roster(sqlite, GROOMER);
  const queue = await import("../lib/provider-payout-queue.ts"), route = await import("../app/api/partner-finance/route.ts");
  await completedBooking(sqlite, db, { id: "BK-UAT-ROUTE", providerId: GROOMER });
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: ROUTE_UAT_NOT_READY });
  sqlite.prepare("DELETE FROM provider_verifications WHERE verification_type='bank_kyc'").run();
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: SANDBOX });
  assert.equal(item(sqlite, "BK-UAT-ROUTE").blocked_reason, "no_beneficiary");

  const plain = await queue.getProviderPayoutQueueDashboard(db);
  assert.equal(plain.queue[0].releasable, false, "without the gate the block stands");
  assert.equal(plain.queue[0].statusLabel, "Waiting: No verified bank account for this provider");
  const read = await route.GET(asActor(FINANCE, "/api/partner-finance"));
  const row = JSON.parse(await read.text()).data.payoutQueue.queue.find((r) => r.booking_id === "BK-UAT-ROUTE");
  assert.equal(row.releasable, true);
  assert.equal(row.statusLabel, "Waiting: No verified bank account for this provider (healed automatically on staging when you release, or on the next payout check)");

  const post = await route.POST(asActor(FINANCE, "/api/partner-finance", { method: "POST", body: JSON.stringify({ action: "release_provider_payout", bookingIds: ["BK-UAT-ROUTE"] }) }));
  assert.equal(post.status, 200, await post.clone().text());
  const body = await post.json();
  assert.equal(body.data.released[0].beneficiaryHealed, true);
  assert.equal(body.data.released[0].dispatch.attempted, false);
  assert.match(body.data.released[0].dispatch.reason, /RazorpayX TEST is not configured/);
  assert.equal(payout(sqlite, "BK-UAT-ROUTE").razorpayx_fund_account_id, FA);
  const audit = sqlite.prepare("SELECT outcome,detail_json FROM security_audit_events WHERE action='partner.payout.release' AND resource_id='BK-UAT-ROUTE'").get();
  assert.equal(audit.outcome, "completed");
  const detail = JSON.parse(audit.detail_json);
  assert.equal(detail.beneficiaryHealed, true);
  assert.equal(detail.dispatch.attempted, false);
  for (const secret of SECRETS) assert.ok(!audit.detail_json.includes(secret));

  const check = await route.POST(asActor(FINANCE, "/api/partner-finance", { method: "POST", body: JSON.stringify({ action: "run_payout_queue" }) }));
  assert.equal(check.status, 200, await check.clone().text());
  assert.deepEqual((await check.json()).data.uatBeneficiaries, { healed: [], failed: [] }, "Check for due payouts now carries the runtime env too");
});

test("a profile Finance wrote by approving commercial terms (no bank details) still gets the TEST bindings, keeping the approver's name on it", async () => {
  const { sqlite, db } = payoutWorld();
  roster(sqlite, GROOMER);
  const seeds = await import("../lib/uat-payout-beneficiaries.ts"), beneficiary = await import("../lib/payout-beneficiary-verification.ts"), setup = await import("../lib/provider-commission-setup.ts");
  await setup.draftProviderCommercialTerms(db, { providerId: GROOMER, engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 30 }], effectiveFrom: "2026-10-01", reason: "Agreed at onboarding interview", actorId: "maker.finance@pawspace.test" });
  await setup.activateProviderCommercialTerms(db, { providerId: GROOMER, approvalReference: "FIN-APR-UAT-1", actorId: "checker.finance@pawspace.test" });
  const profile = () => plain(sqlite.prepare("SELECT updated_by,razorpayx_contact_id,razorpayx_fund_account_id,status,reason FROM provider_compensation_profiles WHERE provider_id=?").get(GROOMER));
  assert.deepEqual(profile(), { updated_by: "checker.finance@pawspace.test", razorpayx_contact_id: null, razorpayx_fund_account_id: null, status: "active", reason: "Engagement set by approved commercial terms" }, "the real terms approval writes a person's name and no bank details");
  const before = await attempt(() => beneficiary.preauthorizeVerifiedPayoutBeneficiary(db, { providerId: GROOMER, scopeType: "booking", scopeId: "BK-TERMS" }));
  assert.equal(before.ok, false);
  const heal = await seeds.ensureUatPayoutBeneficiaries(db, UAT, { providerIds: [GROOMER] });
  assert.deepEqual([heal.healed, heal.skipped, heal.errors], [[GROOMER], [], []]);
  const verified = await beneficiary.preauthorizeVerifiedPayoutBeneficiary(db, { providerId: GROOMER, scopeType: "booking", scopeId: "BK-TERMS" });
  assert.equal(verified.razorpayxFundAccountId, FA);
  assert.deepEqual(profile(), { updated_by: "checker.finance@pawspace.test", razorpayx_contact_id: CONT, razorpayx_fund_account_id: FA, status: "active", reason: "Engagement set by approved commercial terms" }, "bindings filled, the approver's trail untouched");
});

test("under the gate a provider who is not on the UAT roster keeps the plain block and is not marked releasable", async () => {
  const { sqlite, db } = payoutWorld(UAT_NOT_READY);
  const queue = await import("../lib/provider-payout-queue.ts");
  await verifiedRealProvider(sqlite, db, "PRV-REAL-1");
  await completedBooking(sqlite, db, { id: "BK-REAL-Q", providerId: "PRV-REAL-1" });
  await completedBooking(sqlite, db, { id: "BK-REAL-2", providerId: "PRV-REAL-2" });
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  assert.equal(item(sqlite, "BK-REAL-Q").status, "awaiting_release");
  sqlite.prepare("DELETE FROM provider_verifications WHERE application_id='APP-PRV-REAL-1'").run();
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  const dashboard = await queue.getProviderPayoutQueueDashboard(db, { uatSelfHeal: true });
  const row = dashboard.queue.find((r) => r.booking_id === "BK-REAL-Q");
  assert.equal(row.releasable, false, "a real provider's missing bank account is a block, gate or no gate");
  assert.equal(row.statusLabel, "Waiting: No verified bank account for this provider");
  assert.equal(row.blockedLabel, "No verified bank account for this provider");
  assert.equal(dashboard.upcoming.find((u) => u.booking_id === "BK-REAL-2").reasonLabel, "No verified bank account for this provider");
  const refused = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-REAL-Q"], actor: FINANCE, env: UAT_NOT_READY });
  assert.equal(refused.released.length, 0);
  assert.match(refused.refused[0].error, /^No verified bank account for this provider/);
});

test("a release with nothing left to send, and a repeated click on it, say so instead of a missing-record error", async () => {
  const { sqlite, db } = payoutWorld(UAT_NOT_READY);
  roster(sqlite, GROOMER);
  const queue = await import("../lib/provider-payout-queue.ts");
  await completedBooking(sqlite, db, { id: "BK-UAT-FIRST", providerId: GROOMER, completedAt: Date.now() - 10 * DAY });
  await queue.runProviderPayoutQueueSweep(db, { force: true, env: UAT_NOT_READY });
  await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-FIRST"], actor: FINANCE, env: UAT_NOT_READY });
  // The customer is refunded in full after that payout: Rs 700 to recover from the groomer's next payout.
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RF-UAT-FIRST','BK-UAT-FIRST',1000,'Customer refund','completed','support',?,?)").run(Date.now(), Date.now());
  const later = Date.now() + 2 * 3600_000;
  await queue.runProviderPayoutQueueSweep(db, { force: true, asOf: later, env: UAT_NOT_READY });
  assert.equal(Number(sqlite.prepare("SELECT amount FROM provider_payout_recoveries").get().amount), 700);
  await completedBooking(sqlite, db, { id: "BK-UAT-NEXT", providerId: GROOMER });
  await queue.runProviderPayoutQueueSweep(db, { force: true, asOf: later, env: UAT_NOT_READY });
  const first = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-NEXT"], actor: FINANCE, asOf: later, env: UAT_NOT_READY });
  assert.deepEqual(first.refused, []);
  assert.equal(first.released[0].amount, 0);
  assert.equal(first.released[0].payoutRecordCreated, false);
  assert.deepEqual(first.released[0].dispatch, { attempted: false, connected: false, reason: "Nothing left to send: this release created no payout record." });
  const again = await queue.releaseProviderPayouts(db, { bookingIds: ["BK-UAT-NEXT"], actor: FINANCE, asOf: later, env: UAT_NOT_READY });
  assert.equal(again.released[0].duplicatePrevented, true);
  assert.deepEqual(again.released[0].dispatch, { attempted: false, connected: false, reason: "Nothing left to send: this release created no payout record." });
  assert.equal(payout(sqlite, "BK-UAT-NEXT"), undefined);
});

test("a RazorpayX error that quotes an id reaches neither the release response nor the audit row", async () => {
  const provider = await loopbackRazorpayX({ failWith: "fund account fa_LEAKY123 is inactive for account acc_LEAKY456" });
  try {
    const env = { ...ROUTE_UAT, PAWSPACE_RAZORPAYX_CONTRACT_TEST: "true", PAWSPACE_RAZORPAYX_API_BASE_URL: provider.url };
    const { sqlite, db } = payoutWorld(env);
    await seedActors(sqlite, db, [{ id: "USR-UAT-FIN", email: FINANCE, role: "finance" }]);
    roster(sqlite, GROOMER);
    const queue = await import("../lib/provider-payout-queue.ts"), route = await import("../app/api/partner-finance/route.ts");
    await completedBooking(sqlite, db, { id: "BK-UAT-LEAK", providerId: GROOMER });
    await queue.runProviderPayoutQueueSweep(db, { force: true, env });
    const post = await route.POST(asActor(FINANCE, "/api/partner-finance", { method: "POST", body: JSON.stringify({ action: "release_provider_payout", bookingIds: ["BK-UAT-LEAK"] }) }));
    assert.equal(post.status, 200, await post.clone().text());
    const raw = await post.text(), body = JSON.parse(raw);
    assert.equal(body.data.released[0].dispatch.connected, false);
    assert.match(body.data.released[0].dispatch.reason, /RazorpayX TEST payout create failed \(400\): fund account <id> is inactive for account <id>/);
    const audit = sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='partner.payout.release' AND resource_id='BK-UAT-LEAK'").get();
    for (const leaked of ["fa_LEAKY123", "acc_LEAKY456"]) { assert.ok(!raw.includes(leaked), `response carried ${leaked}`); assert.ok(!audit.detail_json.includes(leaked), `audit carried ${leaked}`); }
    assert.equal(payout(sqlite, "BK-UAT-LEAK").status, "retry_pending_sandbox", "left for Send TEST payout");
    assert.equal(provider.calls.length, 1);
  } finally { await provider.close(); }
});

test("the Worker cron hands the runtime env to the payout sweep, and nothing else about the sweep call changed", () => {
  const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const settled = worker.indexOf("await Promise.allSettled([");
  const call = worker.indexOf("runProviderPayoutQueueSweep(env.DB", settled);
  assert.ok(call > settled, "the sweep is still one of the scheduled sweeps");
  assert.match(worker.slice(call, call + 200), /actorId:"system:scheduled-worker",env:env as unknown as Record<string,unknown>\}\)/);
  assert.match(worker, /providerPayoutQueue\.status==="rejected"/);
});

test("no log line written by these tests carries a fund account id, key, secret, account number or webhook secret", () => {
  assert.ok(logged.length >= 0);
  for (const line of logged) for (const secret of SECRETS) assert.ok(!line.includes(secret), `a log line carried ${secret.slice(0, 5)}...: ${line.slice(0, 120)}`);
});
