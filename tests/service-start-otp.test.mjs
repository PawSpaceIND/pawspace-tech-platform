import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, customerSessionCookie, OPS_ORIGIN, nextKey } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__SERVICE_START_OTP_DB__", "__SERVICE_START_OTP_ENV__");

/*
 * Service-start customer OTP: executed against the real route and the real module on a SQLite-backed
 * D1, with verified customer and provider platform sessions from the shared harness.
 *
 * FIXTURE VALUES ONLY. Every threshold below is a synthetic test input chosen so the suite can reach
 * each limit in a few calls. They are NOT business-approved defaults: nothing under lib/ carries them,
 * and the module answers 503 until an operator configures real values. Changing a number here changes
 * only this suite.
 */
const FIXTURE_POLICY = {
  PAWSPACE_SERVICE_START_OTP_ENABLED: "on",
  PAWSPACE_SERVICE_START_OTP_TTL_SECONDS: "120",
  PAWSPACE_SERVICE_START_OTP_MAX_ATTEMPTS: "3",
  PAWSPACE_SERVICE_START_OTP_MAX_ISSUES_PER_BOOKING: "2",
  PAWSPACE_SERVICE_START_OTP_SERVICES: "grooming,pet_taxi",
  PAWSPACE_SERVICE_START_OTP_ELIGIBLE_STATUSES: "assigned,arrived",
};
const hex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const baseEnv = () => ({
  // Non-production runtime with the existing UAT code-return channel on; identity sandbox, payments sandbox.
  APP_ENV: "staging", PAWSPACE_DEPLOYMENT_ENV: "staging", FORBID_PRODUCTION: "true",
  PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_IDENTITY_ENV: "sandbox",
  PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: hex(32),
  PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: hex(32),
  ...FIXTURE_POLICY,
});

let seq = 0;
/** Inserts a row, filling every NOT NULL column without a default so the fixture tracks the real DDL. */
function insertRow(sqlite, table, values) {
  const row = {};
  for (const column of sqlite.prepare(`PRAGMA table_info(${table})`).all()) {
    if (column.name in values) { row[column.name] = values[column.name]; continue; }
    if (column.notnull && column.dflt_value === null) row[column.name] = /INT|REAL|NUM/i.test(column.type) ? 0 : `${table}.${column.name}.${++seq}`;
  }
  const names = Object.keys(row);
  sqlite.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => row[name]));
}

const CUSTOMER = { id: "CUS-SSOTP-1", phone: "9000000111" };
const OTHER_CUSTOMER = { id: "CUS-SSOTP-2", phone: "9000000112" };
const PROVIDER = { id: "PROV-SSOTP-1", phone: "9000000221" };
const OTHER_PROVIDER = { id: "PROV-SSOTP-2", phone: "9000000222" };

async function world(envOverrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SERVICE_START_OTP_DB__ = db;
  globalThis.__SERVICE_START_OTP_ENV__ = { DB: db, ...baseEnv(), ...envOverrides };
  const schema = await import("../lib/canonical-booking-core-schema.ts");
  await schema.ensureCanonicalBookingCoreTables(db);
  const route = await import("../app/api/service-start-otp/route.ts");
  const seedBooking = (id, { customerId = CUSTOMER.id, providerId = PROVIDER.id, serviceCode = "grooming", status = "assigned", workOrder = true } = {}) => {
    insertRow(sqlite, "canonical_bookings", { id, customer_id: customerId, provider_id: providerId, service_code: serviceCode, status });
    if (workOrder) insertRow(sqlite, "provider_work_orders", { id: `WO-${id}`, booking_id: id, provider_id: providerId, service_code: serviceCode, status: "assigned" });
  };
  const customer = (await customerSessionCookie(db, { principalKey: CUSTOMER.phone, customerId: CUSTOMER.id })).cookie;
  const otherCustomer = (await customerSessionCookie(db, { principalKey: OTHER_CUSTOMER.phone, customerId: OTHER_CUSTOMER.id })).cookie;
  const provider = (await customerSessionCookie(db, { principalKey: PROVIDER.phone, customerId: PROVIDER.id, subjectType: "provider" })).cookie;
  const otherProvider = (await customerSessionCookie(db, { principalKey: OTHER_PROVIDER.phone, customerId: OTHER_PROVIDER.id, subjectType: "provider" })).cookie;
  const post = (cookie, body, origin = OPS_ORIGIN) => route.POST(new Request(`${origin}/api/service-start-otp`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const get = (cookie, bookingId, origin = OPS_ORIGIN) => route.GET(new Request(`${origin}/api/service-start-otp?bookingId=${encodeURIComponent(bookingId)}`, { headers: { cookie } }));
  const issue = (cookie, bookingId) => post(cookie, { action: "issue", bookingId });
  const verify = (cookie, bookingId, code, idempotencyKey = nextKey("SS")) => post(cookie, { action: "verify", bookingId, code, idempotencyKey });
  const body = async (response) => ({ status: response.status, ...(await response.json()) });
  const challenges = (bookingId) => sqlite.prepare("SELECT * FROM service_start_otp_challenges WHERE booking_id=? ORDER BY issue_sequence").all(bookingId);
  const audits = () => sqlite.prepare("SELECT action,outcome,detail_json FROM security_audit_events WHERE action LIKE 'service_start_otp.%'").all();
  return { sqlite, db, env: globalThis.__SERVICE_START_OTP_ENV__, seedBooking, customer, otherCustomer, provider, otherProvider, post, get, issue, verify, body, challenges, audits };
}

const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("customer issues a code for their own booking and the assigned provider redeems it once into a consent artifact", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(issued.status, 200, JSON.stringify(issued));
  assert.match(issued.data.code, /^\d{6}$/);
  assert.equal(issued.data.codeDelivery, "customer_session_test_only");
  assert.equal(issued.data.providerId, PROVIDER.id);
  assert.equal(issued.data.issueSequence, 1);
  assert.equal(issued.data.expiresInSeconds, 120);
  assert.equal(issued.data.attemptsAllowed, 3);

  const [stored] = w.challenges("BK-1");
  assert.equal(stored.status, "issued");
  assert.ok(stored.verifier_hash && stored.verifier_salt, "a salted verifier is stored");
  assert.ok(!JSON.stringify(stored).includes(issued.data.code), "the code itself is never stored");

  const consent = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.equal(consent.status, 200, JSON.stringify(consent));
  assert.equal(consent.data.kind, "service_start_customer_consent");
  assert.equal(consent.data.bookingId, "BK-1");
  assert.equal(consent.data.customerId, CUSTOMER.id);
  assert.equal(consent.data.providerId, PROVIDER.id);
  assert.equal(consent.data.serviceStarted, false, "consent is not a service start");
  assert.equal(consent.data.lifecycleIntegration, "not_applied");
  assert.equal(consent.data.replayed, false);
  assert.match(consent.data.consentId, /^SSC-/);
  assert.ok(!JSON.stringify(consent).includes(issued.data.code), "the provider response never echoes the code");

  const [after] = w.challenges("BK-1");
  assert.equal(after.status, "verified");
  assert.equal(after.verifier_hash, null);
  assert.equal(after.verifier_salt, null);
  assert.equal(after.consent_id, consent.data.consentId);
  assert.equal(after.verified_by, `provider:${PROVIDER.id}`);
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-1'").get().status, "assigned", "the booking's lifecycle status is untouched");

  const rows = w.audits();
  assert.deepEqual(rows.map((row) => `${row.action}:${row.outcome}`), ["service_start_otp.issue:completed", "service_start_otp.verify:completed"]);
  assert.ok(rows.every((row) => !row.detail_json.includes(issued.data.code)), "audit detail never carries the code");
});

test("the code never reaches logs, the provider's view, or the customer's status view", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const captured = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(original)) console[level] = (...args) => { captured.push(args.map(String).join(" ")); };
  let issued, consent, customerView, providerView;
  try {
    issued = await w.body(await w.issue(w.customer, "BK-1"));
    customerView = await w.body(await w.get(w.customer, "BK-1"));
    providerView = await w.body(await w.get(w.provider, "BK-1"));
    consent = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  } finally { Object.assign(console, original); }
  assert.equal(issued.status, 200);
  assert.equal(consent.status, 200);
  assert.ok(captured.every((line) => !line.includes(issued.data.code)), `code leaked to console: ${captured.join(" | ")}`);
  for (const view of [customerView, providerView]) {
    assert.equal(view.status, 200, JSON.stringify(view));
    assert.equal(view.data.state, "issued");
    const serialised = JSON.stringify(view);
    assert.ok(!serialised.includes(issued.data.code), "status view echoes the code");
    assert.ok(!/verifier|salt|hash/i.test(serialised), "status view exposes verifier material");
  }
  assert.equal(customerView.data.attemptsRemaining, 3);
  assert.equal(providerView.data.attemptsRemaining, null, "the provider is not told how many guesses remain");
  const verifiedView = await w.body(await w.get(w.provider, "BK-1"));
  assert.equal(verifiedView.data.state, "verified");
  assert.equal(verifiedView.data.consent.serviceStarted, false);
});

test("wrong owner, wrong provider, wrong booking, and principal-type confusion are refused", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  w.seedBooking("BK-2", { providerId: PROVIDER.id });
  w.seedBooking("BK-OTHER", { customerId: OTHER_CUSTOMER.id, providerId: OTHER_PROVIDER.id });

  const notOwner = await w.body(await w.issue(w.otherCustomer, "BK-1"));
  assert.equal(notOwner.status, 404);
  assert.equal(notOwner.code, "booking_not_owned");
  assert.equal(w.challenges("BK-1").length, 0);

  const providerIssuing = await w.body(await w.issue(w.provider, "BK-1"));
  assert.equal(providerIssuing.status, 403);
  assert.equal(providerIssuing.code, "customer_session_required");

  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(issued.status, 200);

  const customerVerifying = await w.body(await w.verify(w.customer, "BK-1", issued.data.code));
  assert.equal(customerVerifying.status, 403);
  assert.equal(customerVerifying.code, "provider_session_required");

  const wrongProvider = await w.body(await w.verify(w.otherProvider, "BK-1", issued.data.code));
  assert.equal(wrongProvider.status, 403);
  assert.equal(wrongProvider.code, "provider_not_assigned");

  const wrongBooking = await w.body(await w.verify(w.provider, "BK-2", issued.data.code));
  assert.equal(wrongBooking.status, 409);
  assert.equal(wrongBooking.code, "no_active_challenge");

  const unknownBooking = await w.body(await w.verify(w.provider, "BK-MISSING", issued.data.code));
  assert.equal(unknownBooking.status, 404);

  const otherCustomerStatus = await w.body(await w.get(w.otherCustomer, "BK-1"));
  assert.equal(otherCustomerStatus.status, 404);
  const otherProviderStatus = await w.body(await w.get(w.otherProvider, "BK-1"));
  assert.equal(otherProviderStatus.status, 404);

  const [challenge] = w.challenges("BK-1");
  assert.equal(challenge.status, "issued");
  assert.equal(challenge.attempts, 0, "refusals before the code check consume no attempt");

  const still = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.equal(still.status, 200, "the rightful provider can still redeem it");
});

test("staff, superuser preview and UAT staff identities get no ownership bypass", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  // Development preview superuser (localhost under the test runtime) holds ["*"]; still refused.
  const preview = await w.body(await w.post("", { action: "issue", bookingId: "BK-1" }, "http://localhost"));
  assert.equal(preview.status, 403, JSON.stringify(preview));
  assert.equal(preview.code, "customer_session_required");
  const previewVerify = await w.body(await w.post("", { action: "verify", bookingId: "BK-1", code: "123456", idempotencyKey: nextKey() }, "http://localhost"));
  assert.equal(previewVerify.status, 403);
  assert.equal(previewVerify.code, "provider_session_required");

  // UAT staff login carrying bookings.manage and customers.manage: the permissions that let staff
  // through requireCustomerOwnership/requireProviderOwnership elsewhere buy nothing here.
  w.sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('ops_fixture','Ops','fixture',?,0,0)").run(JSON.stringify(["bookings.manage", "customers.manage", "providers.manage", "bookings.view", "scheduling.book"]));
  w.sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-OPS','ops@pawspace.test','Ops','ops_fixture','active',0,0)").run();
  const uat = await import("../lib/uat-staging-auth.ts");
  const token = await uat.issueUatToken(w.env, "ops@pawspace.test", 600);
  const staffCookie = `pawspace_uat=${encodeURIComponent(token)}`;
  const staffIssue = await w.body(await w.post(staffCookie, { action: "issue", bookingId: "BK-1" }));
  assert.equal(staffIssue.status, 403, JSON.stringify(staffIssue));
  assert.equal(staffIssue.code, "customer_session_required");
  const staffVerify = await w.body(await w.post(staffCookie, { action: "verify", bookingId: "BK-1", code: "123456", idempotencyKey: nextKey() }));
  assert.equal(staffVerify.status, 403);
  assert.equal(staffVerify.code, "provider_session_required");
  assert.equal(w.challenges("BK-1").length, 0);
});

test("issuance requires the configured service and eligible-status allowlists and an assigned provider", async () => {
  const w = await world();
  w.seedBooking("BK-DONE", { status: "completed" });
  w.seedBooking("BK-CANCELLED", { status: "cancelled" });
  w.seedBooking("BK-SITTING", { serviceCode: "pet_sitting" });
  w.seedBooking("BK-UNASSIGNED", { workOrder: false });

  for (const bookingId of ["BK-DONE", "BK-CANCELLED"]) {
    const refused = await w.body(await w.issue(w.customer, bookingId));
    assert.equal(refused.status, 409, bookingId);
    assert.equal(refused.code, "booking_status_ineligible", "an assigned provider on a finished booking is not enough");
  }
  const service = await w.body(await w.issue(w.customer, "BK-SITTING"));
  assert.equal(service.status, 409);
  assert.equal(service.code, "service_not_enabled");
  const unassigned = await w.body(await w.issue(w.customer, "BK-UNASSIGNED"));
  assert.equal(unassigned.status, 409);
  assert.equal(unassigned.code, "provider_not_assigned");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_challenges").get().n, 0);
});

test("an expired code is refused, reported as expired, and can be reissued", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  w.sqlite.prepare("UPDATE service_start_otp_challenges SET expires_at=? WHERE booking_id='BK-1'").run(Date.now() - 1);
  const view = await w.body(await w.get(w.customer, "BK-1"));
  assert.equal(view.data.state, "expired");
  const late = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.equal(late.status, 410);
  assert.equal(late.code, "challenge_expired");
  const [first] = w.challenges("BK-1");
  assert.equal(first.status, "expired");
  assert.equal(first.verifier_hash, null);
  const reissued = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(reissued.status, 200);
  assert.equal(reissued.data.issueSequence, 2);
  const redeemed = await w.body(await w.verify(w.provider, "BK-1", reissued.data.code));
  assert.equal(redeemed.status, 200);
});

test("the attempt cap exhausts the code atomically and the right code no longer works afterwards", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  const bad = wrongCode(issued.data.code);
  for (const expected of [401, 401]) {
    const refused = await w.body(await w.verify(w.provider, "BK-1", bad));
    assert.equal(refused.status, expected);
    assert.equal(refused.code, "incorrect_code");
  }
  assert.equal((await w.body(await w.get(w.customer, "BK-1"))).data.attemptsRemaining, 1);
  const exhausted = await w.body(await w.verify(w.provider, "BK-1", bad));
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.code, "attempts_exhausted");
  const [challenge] = w.challenges("BK-1");
  assert.equal(challenge.status, "exhausted");
  assert.equal(challenge.attempts, 3);
  assert.equal(challenge.verifier_hash, null, "the verifier is erased once the code is dead");
  const correctTooLate = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.equal(correctTooLate.status, 409);
  assert.equal(correctTooLate.code, "no_active_challenge");
  assert.equal((await w.body(await w.get(w.customer, "BK-1"))).data.state, "exhausted");
  const rejected = w.audits().filter((row) => row.outcome === "rejected").map((row) => JSON.parse(row.detail_json).reason);
  assert.deepEqual(rejected, ["incorrect_code", "incorrect_code", "attempts_exhausted"]);
});

test("a redeemed code cannot be replayed; the same idempotency key returns the same consent, a reused key for another booking is refused", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  w.seedBooking("BK-2");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  const key = nextKey("IDEM");
  const first = await w.body(await w.verify(w.provider, "BK-1", issued.data.code, key));
  assert.equal(first.status, 200);
  const replayNewKey = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.equal(replayNewKey.status, 409);
  assert.equal(replayNewKey.code, "no_active_challenge");
  const sameKey = await w.body(await w.verify(w.provider, "BK-1", issued.data.code, key));
  assert.equal(sameKey.status, 200);
  assert.equal(sameKey.data.consentId, first.data.consentId);
  assert.equal(sameKey.data.replayed, true);
  const sameKeyWrongCode = await w.body(await w.verify(w.provider, "BK-1", wrongCode(issued.data.code), key));
  assert.equal(sameKeyWrongCode.status, 200, "an idempotent replay is answered from the stored result, not re-verified");
  assert.equal(sameKeyWrongCode.data.consentId, first.data.consentId);
  const otherBookingSameKey = await w.body(await w.verify(w.provider, "BK-2", issued.data.code, key));
  assert.equal(otherBookingSameKey.status, 409);
  assert.equal(otherBookingSameKey.code, "idempotency_key_conflict");
  const otherProviderSameKey = await w.body(await w.verify(w.otherProvider, "BK-1", issued.data.code, key));
  assert.equal(otherProviderSameKey.status, 409);
  assert.equal(otherProviderSameKey.code, "idempotency_key_conflict");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 1);
  assert.equal(w.audits().filter((row) => row.action === "service_start_otp.verify" && row.outcome === "completed").length, 1);
});

test("reissue supersedes the live code and stops at the configured cap", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const first = await w.body(await w.issue(w.customer, "BK-1"));
  const second = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(second.status, 200);
  assert.equal(second.data.issueSequence, 2);
  assert.equal(second.data.issuesRemaining, 0);
  assert.notEqual(second.data.challengeId, first.data.challengeId);
  const [one, two] = w.challenges("BK-1");
  assert.equal(one.status, "superseded");
  assert.equal(one.verifier_hash, null);
  assert.equal(two.status, "issued");
  const third = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(third.status, 429);
  assert.equal(third.code, "reissue_limit_reached");
  assert.equal(w.challenges("BK-1").length, 2);
  // The superseded code is a wrong code against the live challenge, so it only burns an attempt.
  if (first.data.code !== second.data.code) {
    const stale = await w.body(await w.verify(w.provider, "BK-1", first.data.code));
    assert.equal(stale.status, 401);
  }
  const live = await w.body(await w.verify(w.provider, "BK-1", second.data.code));
  assert.equal(live.status, 200);
});

test("concurrent verifies of the same code produce exactly one consent", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  // The competitor lands in the gap between the first caller's hash check and its claim UPDATE.
  let competitor;
  w.db.onSql("SET status='verified'", async () => { competitor = await w.body(await w.verify(w.provider, "BK-1", issued.data.code)); });
  const original = await w.body(await w.verify(w.provider, "BK-1", issued.data.code));
  assert.ok(competitor, "the competing verify ran inside the gap");
  const statuses = [original.status, competitor.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify({ original, competitor }));
  const loser = original.status === 409 ? original : competitor;
  assert.equal(loser.code, "challenge_already_used");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_challenges WHERE status='verified'").get().n, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 1);
  assert.equal(w.audits().filter((row) => row.action === "service_start_otp.verify" && row.outcome === "completed").length, 1);
});

test("concurrent issues for one booking leave exactly one live code, and the schema itself forbids two", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  // The competitor runs after the first issuer has read the sequence counter and before its write.
  // The shared-connection harness cannot model two D1 transactions, so the assertion is the outcome
  // the UNIQUE guards guarantee either way: one issuer wins, the other is told it collided.
  let competitor;
  w.db.onSql("SET status='superseded'", async () => { competitor = await w.body(await w.issue(w.customer, "BK-1")); });
  const original = await w.body(await w.issue(w.customer, "BK-1"));
  assert.ok(competitor, "the competing issue ran inside the gap");
  assert.deepEqual([original.status, competitor.status].sort(), [200, 409], JSON.stringify({ original, competitor }));
  assert.equal((original.status === 409 ? original : competitor).code, "issue_conflict");
  assert.ok(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_challenges WHERE booking_id='BK-1' AND status='issued'").get().n <= 1);

  // Structural guard, independent of request ordering: a second live row for a booking is impossible.
  const insert = (id, sequence) => w.sqlite.prepare("INSERT INTO service_start_otp_challenges (id,booking_id,issue_sequence,service_code,customer_id,provider_id,booking_status_at_issue,status,attempts,issued_by,issued_at,expires_at) VALUES (?,'BK-GUARD',?,'grooming','c','p','assigned','issued',0,'t',0,1)").run(id, sequence);
  insert("G-1", 1);
  assert.throws(() => insert("G-2", 2), /UNIQUE|constraint/i, "second live challenge for the same booking");
  w.sqlite.prepare("UPDATE service_start_otp_challenges SET status='superseded' WHERE id='G-1'").run();
  assert.throws(() => insert("G-3", 1), /UNIQUE|constraint/i, "a repeated issue sequence");
  insert("G-4", 2);
});

test("every policy value is required with no default, and the module fails closed when any is missing or invalid", async () => {
  const policy = await import("../lib/service-start-otp-policy.ts");
  const full = { ...baseEnv() };
  assert.deepEqual([...policy.resolveServiceStartOtpPolicy(full).services], ["grooming", "pet_taxi"]);
  for (const name of Object.values(policy.SERVICE_START_OTP_SETTINGS)) {
    if (name === policy.SERVICE_START_OTP_SETTINGS.enabled) continue;
    const missing = { ...full }; delete missing[name];
    assert.throws(() => policy.resolveServiceStartOtpPolicy(missing), (error) => error.code === "policy_not_configured" && error.status === 503 && error.message.includes(name), `${name} unset`);
    const blank = { ...full, [name]: "   " };
    assert.throws(() => policy.resolveServiceStartOtpPolicy(blank), (error) => error.code === "policy_not_configured", `${name} blank`);
  }
  for (const name of [policy.SERVICE_START_OTP_SETTINGS.ttlSeconds, policy.SERVICE_START_OTP_SETTINGS.maxAttempts, policy.SERVICE_START_OTP_SETTINGS.maxIssuesPerBooking]) {
    for (const bad of ["0", "-1", "1.5", "five"]) assert.throws(() => policy.resolveServiceStartOtpPolicy({ ...full, [name]: bad }), (error) => error.code === "policy_invalid", `${name}=${bad}`);
  }
  for (const name of [policy.SERVICE_START_OTP_SETTINGS.services, policy.SERVICE_START_OTP_SETTINGS.eligibleStatuses]) {
    assert.throws(() => policy.resolveServiceStartOtpPolicy({ ...full, [name]: " , " }), (error) => error.code === "policy_not_configured" || error.code === "policy_invalid", `${name} empty list`);
    assert.throws(() => policy.resolveServiceStartOtpPolicy({ ...full, [name]: "grooming;taxi" }), (error) => error.code === "policy_invalid", `${name} malformed`);
  }

  // Through the route: a missing threshold refuses issue, verify and status alike, before any work.
  const w = await world({ PAWSPACE_SERVICE_START_OTP_ELIGIBLE_STATUSES: "" });
  w.seedBooking("BK-1");
  for (const response of [await w.issue(w.customer, "BK-1"), await w.verify(w.provider, "BK-1", "123456"), await w.get(w.customer, "BK-1")]) {
    const result = await w.body(response);
    assert.equal(result.status, 503, JSON.stringify(result));
    assert.equal(result.code, "policy_not_configured");
    assert.match(result.error, /ELIGIBLE_STATUSES/);
  }
  assert.equal(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='service_start_otp_challenges'").get(), undefined, "nothing is provisioned while unconfigured");
});

test("production is refused categorically, and the non-production gate needs the explicit flag, a non-live identity runtime and the sandbox code channel", async () => {
  const cases = [
    [{ PAWSPACE_DEPLOYMENT_ENV: "production" }, "production_refused"],
    [{ APP_ENV: "production" }, "production_refused"],
    [{ APP_ENV: "Production", PAWSPACE_DEPLOYMENT_ENV: "staging" }, "production_refused"],
    [{ PAWSPACE_SERVICE_START_OTP_ENABLED: "off" }, "disabled"],
    [{ PAWSPACE_SERVICE_START_OTP_ENABLED: "true" }, "disabled"],
    [{ PAWSPACE_SERVICE_START_OTP_ENABLED: undefined }, "disabled"],
    [{ PAWSPACE_IDENTITY_ENV: "live" }, "live_identity_refused"],
    [{ PAWSPACE_UAT_LOGIN: "off" }, "sandbox_channel_off"],
    [{ PAWSPACE_UAT_SIGNING_KEY: "short" }, "sandbox_channel_off"],
  ];
  for (const [overrides, code] of cases) {
    const w = await world(overrides);
    for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete w.env[key];
    w.seedBooking("BK-1");
    for (const response of [await w.issue(w.customer, "BK-1"), await w.verify(w.provider, "BK-1", "123456"), await w.get(w.customer, "BK-1")]) {
      const result = await w.body(response);
      assert.equal(result.status, 503, `${JSON.stringify(overrides)} -> ${JSON.stringify(result)}`);
      assert.equal(result.code, code, JSON.stringify(overrides));
    }
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'service_start_otp%'").get().n, 0);
  }
  // A production runtime refuses even with every policy value present and the sandbox channel on.
  const policy = await import("../lib/service-start-otp-policy.ts");
  assert.throws(() => policy.assertServiceStartOtpRuntime(new Request("http://localhost/api/service-start-otp"), { ...baseEnv(), PAWSPACE_DEPLOYMENT_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "on" }), (error) => error.code === "production_refused");
});

test("the verifier secret must be configured: no local development fallback outside the preview runtime", async () => {
  const policy = await import("../lib/service-start-otp-policy.ts");
  const previous = process.env.PAWSPACE_LOCAL_PREVIEW;
  process.env.PAWSPACE_LOCAL_PREVIEW = "off";
  try {
    const env = { ...baseEnv() }; delete env.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT;
    assert.throws(() => policy.resolveServiceStartOtpSecret(env), (error) => error.code === "secret_not_configured" && error.status === 503);
    assert.throws(() => policy.resolveServiceStartOtpSecret({ ...env, PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "too-short" }), (error) => error.code === "secret_not_configured");
    const w = await world({ PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: undefined });
    delete w.env.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT;
    w.seedBooking("BK-1");
    const result = await w.body(await w.issue(w.customer, "BK-1"));
    assert.equal(result.status, 503, JSON.stringify(result));
    assert.equal(result.code, "secret_not_configured");
  } finally {
    if (previous === undefined) delete process.env.PAWSPACE_LOCAL_PREVIEW; else process.env.PAWSPACE_LOCAL_PREVIEW = previous;
  }
});

test("malformed requests are refused before any session or policy work", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  assert.equal((await w.body(await w.post(w.customer, { action: "issue" }))).status, 400);
  assert.equal((await w.body(await w.post(w.customer, { action: "dance", bookingId: "BK-1" }))).status, 400);
  const noKey = await w.body(await w.post(w.provider, { action: "verify", bookingId: "BK-1", code: "123456" }));
  assert.equal(noKey.status, 400);
  assert.equal(noKey.code, "idempotency_key_required");
  const longKey = await w.body(await w.post(w.provider, { action: "verify", bookingId: "BK-1", code: "123456", idempotencyKey: "k".repeat(129) }));
  assert.equal(longKey.status, 400);
  const badShape = await w.body(await w.post(w.provider, { action: "verify", bookingId: "BK-1", code: "12345", idempotencyKey: nextKey() }));
  assert.equal(badShape.status, 400);
  assert.equal(badShape.code, "code_shape_invalid");
  const crossOrigin = await w.post(w.customer, { action: "issue", bookingId: "BK-1" });
  assert.equal(crossOrigin.status, 200);
  const foreign = await w.body(await (await route()).POST(new Request(`${OPS_ORIGIN}/api/service-start-otp`, { method: "POST", headers: { cookie: w.customer, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ action: "issue", bookingId: "BK-1" }) })));
  assert.equal(foreign.status, 403);
  const anonymous = await w.body(await w.post("", { action: "issue", bookingId: "BK-1" }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, JSON.stringify(anonymous));
});


test("a booking that is cancelled or completed after the code was issued cannot acquire new consent; the historical replay stays distinct", async () => {
  const w = await world();
  for (const [bookingId, later] of [["BK-CANCEL", "cancelled"], ["BK-DONE", "completed"], ["BK-ODD", "reassignment_offered"]]) {
    w.seedBooking(bookingId);
    const issued = await w.body(await w.issue(w.customer, bookingId));
    assert.equal(issued.status, 200);
    w.sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(later, bookingId);
    const refused = await w.body(await w.verify(w.provider, bookingId, issued.data.code));
    assert.equal(refused.status, 409, `${later}: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, "booking_status_ineligible");
    assert.match(refused.error, new RegExp(later));
    const [challenge] = w.challenges(bookingId);
    assert.equal(challenge.status, "issued", "the refusal is fail-closed, not a consumption");
    assert.equal(challenge.attempts, 0);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys WHERE booking_id=?").get(bookingId).n, 0, "no consent is recorded");
    assert.equal((await w.body(await w.get(w.provider, bookingId))).data.consent, null);
  }
  // A status change INSIDE the allowlist is not drift: assigned -> arrived still verifies.
  w.seedBooking("BK-ARRIVED");
  const issued = await w.body(await w.issue(w.customer, "BK-ARRIVED"));
  w.sqlite.prepare("UPDATE canonical_bookings SET status='arrived' WHERE id='BK-ARRIVED'").run();
  const ok = await w.body(await w.verify(w.provider, "BK-ARRIVED", issued.data.code));
  assert.equal(ok.status, 200, JSON.stringify(ok));

  // Consent recorded while eligible, booking cancelled afterwards: the same idempotency key replays
  // the historical artifact (replayed:true); any fresh key is refused and creates nothing.
  w.seedBooking("BK-HIST");
  const hist = await w.body(await w.issue(w.customer, "BK-HIST"));
  const key = nextKey("HIST");
  const consent = await w.body(await w.verify(w.provider, "BK-HIST", hist.data.code, key));
  assert.equal(consent.status, 200);
  w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-HIST'").run();
  const replay = await w.body(await w.verify(w.provider, "BK-HIST", hist.data.code, key));
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.consentId, consent.data.consentId);
  assert.equal(replay.data.serviceStarted, false);
  const fresh = await w.body(await w.verify(w.provider, "BK-HIST", hist.data.code));
  assert.equal(fresh.status, 409);
  assert.equal(fresh.code, "booking_status_ineligible");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys WHERE booking_id='BK-HIST'").get().n, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_challenges WHERE booking_id='BK-HIST' AND status='verified'").get().n, 1);
});

test("reassignment, customer or service drift after issue is refused by the live binding check", async () => {
  const w = await world();
  w.seedBooking("BK-REASSIGN");
  const issued = await w.body(await w.issue(w.customer, "BK-REASSIGN"));
  w.sqlite.prepare("UPDATE provider_work_orders SET provider_id=? WHERE booking_id='BK-REASSIGN'").run(OTHER_PROVIDER.id);
  const original = await w.body(await w.verify(w.provider, "BK-REASSIGN", issued.data.code));
  assert.equal(original.status, 403);
  assert.equal(original.code, "provider_not_assigned");
  const replacement = await w.body(await w.verify(w.otherProvider, "BK-REASSIGN", issued.data.code));
  assert.equal(replacement.status, 409);
  assert.equal(replacement.code, "challenge_binding_mismatch", "the code was issued for the previous provider");
  assert.equal(w.challenges("BK-REASSIGN")[0].status, "issued");
  // The customer issues a fresh code for the replacement provider; only that provider can redeem it.
  const reissued = await w.body(await w.issue(w.customer, "BK-REASSIGN"));
  assert.equal(reissued.status, 200);
  assert.equal(reissued.data.providerId, OTHER_PROVIDER.id);
  assert.equal((await w.body(await w.verify(w.provider, "BK-REASSIGN", reissued.data.code))).status, 403);
  assert.equal((await w.body(await w.verify(w.otherProvider, "BK-REASSIGN", reissued.data.code))).status, 200);

  w.seedBooking("BK-CUST");
  const custIssued = await w.body(await w.issue(w.customer, "BK-CUST"));
  w.sqlite.prepare("UPDATE canonical_bookings SET customer_id=? WHERE id='BK-CUST'").run(OTHER_CUSTOMER.id);
  const custDrift = await w.body(await w.verify(w.provider, "BK-CUST", custIssued.data.code));
  assert.equal(custDrift.status, 409);
  assert.equal(custDrift.code, "challenge_binding_mismatch");

  w.seedBooking("BK-SVC");
  const svcIssued = await w.body(await w.issue(w.customer, "BK-SVC"));
  w.sqlite.prepare("UPDATE canonical_bookings SET service_code='pet_sitting' WHERE id='BK-SVC'").run();
  const svcDrift = await w.body(await w.verify(w.provider, "BK-SVC", svcIssued.data.code));
  assert.equal(svcDrift.status, 409);
  assert.equal(svcDrift.code, "service_not_enabled");
  for (const id of ["BK-CUST", "BK-SVC"]) assert.equal(w.challenges(id)[0].status, "issued");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 1, "only the legitimate replacement-provider consent exists");
});

test("drift that lands between the hash check and the claim is caught inside the atomic claim", async () => {
  const drifts = [
    ["cancelled in the gap", (w) => w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-GAP'").run(), (w) => w.sqlite.prepare("UPDATE canonical_bookings SET status='assigned' WHERE id='BK-GAP'").run()],
    ["completed in the gap", (w) => w.sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='BK-GAP'").run(), (w) => w.sqlite.prepare("UPDATE canonical_bookings SET status='assigned' WHERE id='BK-GAP'").run()],
    ["reassigned in the gap", (w) => w.sqlite.prepare("UPDATE provider_work_orders SET provider_id=? WHERE booking_id='BK-GAP'").run(OTHER_PROVIDER.id), (w) => w.sqlite.prepare("UPDATE provider_work_orders SET provider_id=? WHERE booking_id='BK-GAP'").run(PROVIDER.id)],
    ["customer changed in the gap", (w) => w.sqlite.prepare("UPDATE canonical_bookings SET customer_id=? WHERE id='BK-GAP'").run(OTHER_CUSTOMER.id), (w) => w.sqlite.prepare("UPDATE canonical_bookings SET customer_id=? WHERE id='BK-GAP'").run(CUSTOMER.id)],
    ["service changed in the gap", (w) => w.sqlite.prepare("UPDATE canonical_bookings SET service_code='pet_sitting' WHERE id='BK-GAP'").run(), (w) => w.sqlite.prepare("UPDATE canonical_bookings SET service_code='grooming' WHERE id='BK-GAP'").run()],
    ["work order deleted in the gap", (w) => w.sqlite.prepare("DELETE FROM provider_work_orders WHERE booking_id='BK-GAP'").run(), (w) => insertRow(w.sqlite, "provider_work_orders", { id: "WO-BK-GAP-2", booking_id: "BK-GAP", provider_id: PROVIDER.id, service_code: "grooming", status: "assigned" })],
  ];
  for (const [label, drift, restore] of drifts) {
    const w = await world();
    w.seedBooking("BK-GAP");
    const issued = await w.body(await w.issue(w.customer, "BK-GAP"));
    let fired = false;
    w.db.onSql("SET status='verified'", async () => { fired = true; drift(w); });
    const refused = await w.body(await w.verify(w.provider, "BK-GAP", issued.data.code));
    assert.ok(fired, `${label}: the drift hook ran before the claim`);
    assert.equal(refused.status, 409, `${label}: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, "booking_drift", label);
    const [challenge] = w.challenges("BK-GAP");
    assert.equal(challenge.status, "issued", `${label}: the challenge is untouched`);
    assert.ok(challenge.verifier_hash, `${label}: the verifier survives the refused claim`);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 0, label);
    assert.ok(w.audits().some((row) => row.outcome === "rejected" && JSON.parse(row.detail_json).reason === "booking_drift"), label);
    // Once the booking is back in an eligible, correctly bound state the same code redeems once.
    restore(w);
    const ok = await w.body(await w.verify(w.provider, "BK-GAP", issued.data.code));
    assert.equal(ok.status, 200, `${label} after restore: ${JSON.stringify(ok)}`);
    assert.equal(ok.data.serviceStarted, false);
  }
});

test("thresholds must be finite safe positive integers and the TTL must yield an exact expiry", async () => {
  const policy = await import("../lib/service-start-otp-policy.ts");
  const full = { ...baseEnv() };
  const invalid = (name, value) => assert.throws(() => policy.resolveServiceStartOtpPolicy({ ...full, [name]: value }), (error) => error.code === "policy_invalid" && error.status === 503, `${name}=${JSON.stringify(value)}`);
  for (const name of [policy.SERVICE_START_OTP_SETTINGS.ttlSeconds, policy.SERVICE_START_OTP_SETTINGS.maxAttempts, policy.SERVICE_START_OTP_SETTINGS.maxIssuesPerBooking]) {
    for (const bad of ["Infinity", "-Infinity", "NaN", "1e3", "+5", "0x10", "99999999999999999999", String(Number.MAX_SAFE_INTEGER + 2), "1_000", " 1 2 "]) invalid(name, bad);
  }
  // Within safe-integer range as a number, but not as milliseconds: refused without any business cap.
  invalid(policy.SERVICE_START_OTP_SETTINGS.ttlSeconds, "9007199254741");
  invalid(policy.SERVICE_START_OTP_SETTINGS.ttlSeconds, String(Number.MAX_SAFE_INTEGER));
  const large = policy.resolveServiceStartOtpPolicy({ ...full, PAWSPACE_SERVICE_START_OTP_MAX_ATTEMPTS: String(Number.MAX_SAFE_INTEGER) });
  assert.equal(large.maxAttempts, Number.MAX_SAFE_INTEGER, "a large but safe integer is accepted: no invented maximum");
  assert.equal(policy.resolveServiceStartOtpPolicy({ ...full, PAWSPACE_SERVICE_START_OTP_TTL_SECONDS: "007" }).ttlSeconds, 7);
  const ok = policy.resolveServiceStartOtpPolicy(full);
  assert.equal(policy.serviceStartOtpExpiry(1_000, ok), 1_000 + 120_000);
  assert.throws(() => policy.serviceStartOtpExpiry(Number.MAX_SAFE_INTEGER, ok), (error) => error.code === "policy_invalid");
  assert.throws(() => policy.serviceStartOtpExpiry(1.5, ok), (error) => error.code === "policy_invalid");

  const w = await world({ PAWSPACE_SERVICE_START_OTP_TTL_SECONDS: "99999999999999999999" });
  w.seedBooking("BK-1");
  const result = await w.body(await w.issue(w.customer, "BK-1"));
  assert.equal(result.status, 503, JSON.stringify(result));
  assert.equal(result.code, "policy_invalid");
  assert.match(result.error, /TTL_SECONDS/);
});


test("cross-booking reuse of one idempotency key in the claim window: exactly one booking wins the key, the loser consumes nothing and can recover", async () => {
  // Reproduces the review probe: two assigned bookings for the same provider, separate codes, both
  // verifies carrying SAME-RACE-KEY. The competitor runs after the original's pre-checks (which saw no
  // key row yet) and before the original's claim batch, so only the atomic claim+reserve can stop it.
  // The hook sits on the original's active-challenge read: with the harness's single shared SQLite
  // connection a competitor started inside the original's batch would join that transaction, which
  // real D1 does not do; hooking before the batch models two separate D1 transactions faithfully.
  const w = await world();
  w.seedBooking("KEY-1");
  w.seedBooking("KEY-2");
  const one = await w.body(await w.issue(w.customer, "KEY-1"));
  const two = await w.body(await w.issue(w.customer, "KEY-2"));
  const RACE_KEY = "SAME-RACE-KEY";
  let competitor;
  w.db.onSql("WHERE booking_id=? AND status='issued'", async () => { competitor = await w.body(await w.verify(w.provider, "KEY-2", two.data.code, RACE_KEY)); });
  const original = await w.body(await w.verify(w.provider, "KEY-1", one.data.code, RACE_KEY));
  assert.ok(competitor, "the competing verify ran inside the window");
  assert.equal(competitor.status, 200, JSON.stringify(competitor));
  assert.equal(competitor.data.bookingId, "KEY-2");
  assert.equal(original.status, 409, JSON.stringify(original));
  assert.equal(original.code, "idempotency_key_conflict");

  const keys = w.sqlite.prepare("SELECT idempotency_key,booking_id FROM service_start_otp_action_keys").all().map((row) => ({ ...row }));
  assert.deepEqual(keys, [{ idempotency_key: RACE_KEY, booking_id: "KEY-2" }], "the key belongs to exactly one booking");
  const verified = w.sqlite.prepare("SELECT booking_id,consent_id FROM service_start_otp_challenges WHERE status='verified'").all();
  assert.deepEqual(verified.map((row) => row.booking_id), ["KEY-2"], "no unkeyed consent exists");
  assert.equal(verified[0].consent_id, competitor.data.consentId);
  const [loser] = w.challenges("KEY-1");
  assert.equal(loser.status, "issued", "the loser's challenge was not consumed");
  assert.ok(loser.verifier_hash && loser.verifier_salt, "the loser's verifier is intact");
  assert.equal(loser.attempts, 0);
  assert.equal(loser.consent_id, null);
  assert.equal(w.audits().filter((row) => row.outcome === "completed" && row.action === "service_start_otp.verify").length, 1);
  assert.ok(w.audits().some((row) => row.outcome === "rejected" && JSON.parse(row.detail_json).reason === "idempotency_key_conflict"));

  // Recovery and error cases after the race.
  const retryRaceKey = await w.body(await w.verify(w.provider, "KEY-1", one.data.code, RACE_KEY));
  assert.equal(retryRaceKey.status, 409, "the taken key is still refused for KEY-1 by the pre-check");
  assert.equal(retryRaceKey.code, "idempotency_key_conflict");
  assert.equal(w.challenges("KEY-1")[0].status, "issued");
  const winnerReplay = await w.body(await w.verify(w.provider, "KEY-2", two.data.code, RACE_KEY));
  assert.equal(winnerReplay.status, 200, "same-booking replay is preserved for the winner");
  assert.equal(winnerReplay.data.replayed, true);
  assert.equal(winnerReplay.data.consentId, competitor.data.consentId);
  const recovered = await w.body(await w.verify(w.provider, "KEY-1", one.data.code, nextKey("FRESH")));
  assert.equal(recovered.status, 200, `fresh key recovers KEY-1: ${JSON.stringify(recovered)}`);
  assert.equal(recovered.data.replayed, false);
  assert.notEqual(recovered.data.consentId, competitor.data.consentId);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 2);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_challenges WHERE status='verified'").get().n, 2);
  const onceOnly = await w.body(await w.verify(w.provider, "KEY-1", one.data.code, nextKey("AGAIN")));
  assert.equal(onceOnly.status, 409, "one-time semantics survive the recovery");
  assert.equal(onceOnly.code, "no_active_challenge");
});

test("the same cross-booking key race at the reviewer's hook point never leaves a consent without its key", async () => {
  // Hooking the claim statement itself puts the competitor inside the original's batch on this
  // shared-connection harness, so the final rows cannot be read as two D1 transactions would leave
  // them. What must hold in every model is the invariant the defect broke: every verified challenge
  // has exactly one key row, at most one caller succeeds, and no challenge is half-consumed.
  const w = await world();
  w.seedBooking("KEY-1");
  w.seedBooking("KEY-2");
  const one = await w.body(await w.issue(w.customer, "KEY-1"));
  const two = await w.body(await w.issue(w.customer, "KEY-2"));
  let competitor;
  w.db.onSql("SET status='verified'", async () => { competitor = await w.body(await w.verify(w.provider, "KEY-2", two.data.code, "SAME-RACE-KEY")); });
  const original = await w.body(await w.verify(w.provider, "KEY-1", one.data.code, "SAME-RACE-KEY"));
  assert.ok(competitor);
  assert.ok([original.status, competitor.status].filter((status) => status === 200).length <= 1, JSON.stringify({ original, competitor }));
  assert.ok([original, competitor].some((result) => result.status === 409 && result.code === "idempotency_key_conflict"), JSON.stringify({ original, competitor }));
  const verified = w.sqlite.prepare("SELECT booking_id,consent_id FROM service_start_otp_challenges WHERE status='verified'").all();
  const keys = w.sqlite.prepare("SELECT booking_id FROM service_start_otp_action_keys").all();
  assert.equal(verified.length, keys.length, `unkeyed consent: verified=${JSON.stringify(verified)} keys=${JSON.stringify(keys)}`);
  assert.ok(verified.length <= 1);
  for (const row of w.sqlite.prepare("SELECT status,verifier_hash,consent_id FROM service_start_otp_challenges").all()) {
    if (row.status === "issued") assert.ok(row.verifier_hash && row.consent_id === null, "an unconsumed challenge keeps its verifier and has no consent");
    else assert.ok(row.status === "verified" && row.verifier_hash === null && row.consent_id, "a consumed challenge is fully verified");
  }
});

test("a reserved key is never written for a claim that did not happen", async () => {
  const w = await world();
  w.seedBooking("BK-1");
  const issued = await w.body(await w.issue(w.customer, "BK-1"));
  // Drift in the claim window: the UPDATE claims nothing, so the INSERT ... SELECT reserves nothing.
  w.db.onSql("SET status='verified'", async () => { w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-1'").run(); });
  const key = nextKey("DRIFT");
  const drifted = await w.body(await w.verify(w.provider, "BK-1", issued.data.code, key));
  assert.equal(drifted.status, 409);
  assert.equal(drifted.code, "booking_drift");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 0, "no key row for a refused claim");
  // The same key is therefore still usable once the booking is eligible again: it was never spent.
  w.sqlite.prepare("UPDATE canonical_bookings SET status='assigned' WHERE id='BK-1'").run();
  const ok = await w.body(await w.verify(w.provider, "BK-1", issued.data.code, key));
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.data.replayed, false);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM service_start_otp_action_keys").get().n, 1);
});

async function route() { return import("../app/api/service-start-otp/route.ts"); }

test('route action selection cannot grant another role or invoke inherited operation names',async()=>{
 const w=await world();w.seedBooking('ACTION-BINDING');
 for(const action of ['__proto__','constructor','toString','unknown'])assert.equal((await w.post(w.customer,{action,bookingId:'ACTION-BINDING'})).status,400);
 assert.equal((await w.issue(w.provider,'ACTION-BINDING')).status,403);
 assert.equal((await w.verify(w.customer,'ACTION-BINDING','123456','ACTION-KEY')).status,403);
 assert.equal((await w.issue('','ACTION-BINDING')).status,401);
 assert.equal(w.challenges('ACTION-BINDING').length,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM service_start_otp_action_keys').get().n,0);
});
