/*
 * Owner decision C (27 Sept 2026) and the four commission gaps from the #1111 review.
 *
 *  C. PawSpace's default commission is 30% for every commission-based provider in every service. Finance can change a
 *     service's default (10-40%, maker-checker, never back-dated, one control for every service at once); a provider can
 *     get their own value at onboarding; one booking can get an override a second person approves. A booking resolves
 *     order override > provider term > service default, and the Finance screen says so.
 *  1. A provider's engagement (commission / full-time / funeral vendor) could be changed by one person through
 *     save_provider_profile. It now needs a proposal and a different approver; the one-person write is refused with 409.
 *  2. A provider's set of terms was checked all-or-nothing and then activated one term at a time. It now applies in one
 *     guarded batch: a change landing between the checks and the batch leaves nothing half-applied.
 *  3. Older percentages carried over as active terms approved by 'system:legacy-commission-migration' show "Carried over,
 *     needs re-approval" in Finance; a second person re-approves them, audited, and payouts keep using them meanwhile.
 *  4. A funeral or memorial booking's override can be any share from 0% to 100%; commission services keep 10-40%.
 *
 * Everything EXECUTES the real modules and routes on an in-memory SQLite database. Modules added by this change are
 * imported inside the tests that need them, so on the code before it each test fails on its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__COMMISSION_DEFAULTS_DB__", "__COMMISSION_DEFAULTS_ENV__");
process.env.FORBID_PRODUCTION = "true";
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const terms = await import("../lib/provider-commercial-terms.ts");
const commission = await import("../lib/provider-commission-governance.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");

const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const MAKER = "finance.maker@pawspace.test", CHECKER = "finance.checker@pawspace.test", OTHER = "finance.other@pawspace.test", LEGACY_SETTER = "finance.old@pawspace.test";
const DAY = 86_400_000, NOW = Date.now();
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const TODAY = isoDay(NOW), YESTERDAY = isoDay(NOW - DAY), NEXT_MONTH = isoDay(NOW + 30 * DAY), LATER = isoDay(NOW + 40 * DAY);
const SEED_MAKER = "system:default-commission-seed", SEED_APPROVER = "system:owner-decision-c", SEED_REFERENCE = "OWNER-DECISION-C-2026-09-27";
const COMMISSION_SERVICES = ["boarding", "dog_training", "dog_walking", "grooming", "pet_sitting", "pet_taxi"];

function defaultsWorld() {
  const { sqlite, db } = world("__COMMISSION_DEFAULTS_DB__", "__COMMISSION_DEFAULTS_ENV__", SANDBOX);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);
  `);
  return { sqlite, db };
}
const actors = (sqlite, db) => seedActors(sqlite, db, [{ id: "USR-FIN-M", email: MAKER, role: "finance" }, { id: "USR-FIN-C", email: CHECKER, role: "finance" }, { id: "USR-FIN-O", email: OTHER, role: "finance" }, { id: "USR-FIN-L", email: LEGACY_SETTER, role: "finance" }]);
function booking(sqlite, { id, providerId, service = "grooming", total = 1000, day = TODAY, status = "confirmed" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,scheduled_start,created_at,updated_at) VALUES (?,?,'blr',?,?,?,?,'INR',?,?,?)").run(id, `CUS-${id}`, service, providerId, status, total, `${day}T05:00:00.000Z`, NOW, NOW);
}
function completedCommissionJob(sqlite, { id, providerId, service = "grooming", total = 1000 }) {
  booking(sqlite, { id, providerId, service, total, status: "completed" });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,'commission',?,'completed',?,?)").run(`WO-${id}`, id, providerId, service, NOW, NOW);
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,actor_id,occurred_at) VALUES (?,?,'booking_completed','provider',?)").run(`EV-${id}`, id, NOW - DAY);
}
async function capacityProvider(sqlite, db, id, services, model = "commission") {
  await capacity.ensureProviderCapacityTables(db);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'blr',?,?,?,'[\"blr-east\"]',1,4.8,95,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(id, `Provider ${id}`, model, JSON.stringify(services), NOW);
}
async function activeTerm(db, { serviceCode, providerId = null, model = "commission_standard", share, effectiveFrom, reference }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode, providerId, engagementModel: model, providerSharePct: share, effectiveFrom, reason: `${serviceCode} commercial terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: reference, actorId: CHECKER });
  return draft.id;
}
const payoutOf = async (db, bookingId) => { const p = await terms.computeOrderPayout(db, { bookingId, actorId: CHECKER, persist: false }); return [p.providerNetPayout, p.platformFee, p.platformGst, p.termSource]; };
async function partnerFinance() {
  const route = await import("../app/api/partner-finance/route.ts");
  return { route, post: (email, body) => route.POST(asActor(email, "/api/partner-finance", { method: "POST", body: JSON.stringify(body) })), read: async (email = CHECKER) => { const response = await route.GET(asActor(email, "/api/partner-finance")); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data; } };
}
const audits = (sqlite, prefix) => sqlite.prepare("SELECT action,actor_email,outcome FROM security_audit_events WHERE action LIKE ? ORDER BY created_at,rowid").all(`${prefix}%`).map((a) => [a.action, a.actor_email, a.outcome]);
/* Runs `change` once, right before the first batch that activates terms: a concurrent request landing between the
 * approver's checks and the activation itself. Returns a restore function that reports whether it ran. */
function concurrentChangeBeforeActivation(db, change) {
  const original = db.batch;
  let ran = false;
  db.batch = async (list) => { if (!ran && list.some((statement) => /SET status='active'/.test(statement.sql ?? ""))) { ran = true; change(); } return original(list); };
  return () => { db.batch = original; return ran; };
}
const pageText = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("every commission service without a default gets PawSpace 30% through the audited path; a default Finance set is untouched", async () => {
  const { sqlite, db } = defaultsWorld();
  await actors(sqlite, db);
  // Finance set boarding at 25% (in force) and dog walking at 35% from next month; a grooming change to 20% waits for approval.
  const boarding = await activeTerm(db, { serviceCode: "boarding", share: 0.75, effectiveFrom: "2026-01-01", reference: "FIN-APR-BRD" });
  const walking = await activeTerm(db, { serviceCode: "dog_walking", share: 0.65, effectiveFrom: NEXT_MONTH, reference: "FIN-APR-WALK" });
  const groomingProposal = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.8, effectiveFrom: NEXT_MONTH, reason: "Lower grooming default proposed", actorId: MAKER });
  const untouched = (id) => sqlite.prepare("SELECT status,provider_share_pct,approved_by,updated_at FROM provider_commercial_terms WHERE id=?").get(id);
  const before = [untouched(boarding), untouched(walking), untouched(groomingProposal.id)];
  // Seed drafts an interrupted run left behind are withdrawn on every pass, never left waiting for approval: for a service
  // still missing its default and for one that already has a default Finance set.
  const leftBehind = await terms.saveCommercialTerm(db, { serviceCode: "pet_taxi", engagementModel: "commission_standard", providerSharePct: 0.7, effectiveFrom: TODAY, reason: "Interrupted automatic default", actorId: SEED_MAKER });
  const leftBehindWhereSet = await terms.saveCommercialTerm(db, { serviceCode: "boarding", engagementModel: "commission_standard", providerSharePct: 0.7, effectiveFrom: TODAY, reason: "Interrupted automatic default", actorId: SEED_MAKER });

  const { read } = await partnerFinance();
  const data = await read();

  const defaults = sqlite.prepare("SELECT id,service_code,engagement_model,provider_share_pct,created_by,approved_by,approval_reference,effective_from FROM provider_commercial_terms WHERE provider_id IS NULL AND status='active' ORDER BY service_code,effective_from").all();
  assert.deepEqual(defaults.map((r) => [r.service_code, r.provider_share_pct, r.approved_by]), [["boarding", 0.75, CHECKER], ["dog_training", 0.7, SEED_APPROVER], ["dog_walking", 0.65, CHECKER], ["grooming", 0.7, SEED_APPROVER], ["pet_sitting", 0.7, SEED_APPROVER], ["pet_taxi", 0.7, SEED_APPROVER]], "each commission service without an active default is seeded at PawSpace 30%; the defaults Finance set are kept");
  assert.equal(untouched(leftBehind.id).status, "withdrawn", "the left-behind seed draft was replaced");
  assert.equal(untouched(leftBehindWhereSet.id).status, "withdrawn", "a left-behind seed draft is withdrawn even where the service already has its default");
  const seeded = defaults.filter((r) => r.approved_by === SEED_APPROVER);
  for (const row of seeded) {
    assert.deepEqual([row.created_by, row.approval_reference, row.effective_from, row.engagement_model], [SEED_MAKER, SEED_REFERENCE, TODAY, row.service_code === "grooming" ? "commission_groomer" : "commission_standard"], row.service_code);
    assert.deepEqual(sqlite.prepare("SELECT action,actor_id FROM commercial_terms_audit WHERE term_id=? ORDER BY created_at,rowid").all(row.id).map((a) => [a.action, a.actor_id]), [["drafted", SEED_MAKER], ["activated", SEED_APPROVER]], `the ${row.service_code} seed went through the normal draft + activate path, audited`);
  }
  assert.deepEqual([untouched(boarding), untouched(walking), untouched(groomingProposal.id)], before, "Finance's defaults and its waiting proposal are not touched");

  // The Finance screen shows each service's default, and which ones were set automatically.
  const screen = Object.fromEntries(data.commercialTerms.defaults.services.map((s) => [s.serviceCode, s]));
  assert.deepEqual(Object.keys(screen), COMMISSION_SERVICES);
  assert.deepEqual([screen.pet_taxi.inForce.pawspaceCommissionPercent, screen.pet_taxi.inForce.needsPersonApproval, screen.pet_taxi.waiting.length], [30, "Set automatically at 30%, needs approval", 0]);
  assert.deepEqual([screen.boarding.inForce.pawspaceCommissionPercent, screen.boarding.inForce.needsPersonApproval], [25, null]);
  assert.deepEqual([screen.dog_walking.inForce, screen.dog_walking.scheduled.map((t) => [t.pawspaceCommissionPercent, t.effectiveFrom])], [null, [[35, NEXT_MONTH]]]);
  assert.deepEqual(screen.grooming.waiting.map((t) => [t.pawspaceCommissionPercent, t.createdBy]), [[20, MAKER]]);
  const { default: CommissionDefaultsPanel } = await import("../app/team/finance/partners/commission-defaults-panel.tsx");
  const rendered = pageText(renderToStaticMarkup(React.createElement(CommissionDefaultsPanel, { defaults: data.commercialTerms.defaults, approvalNeeded: data.commercialTerms.approvalNeeded })));
  assert.match(rendered, new RegExp(`pet taxi PawSpace 30% since ${TODAY} · Set automatically at 30%, needs approval`));
  assert.match(rendered, /boarding PawSpace 25% since 2026-01-01 Approved by finance\.checker@pawspace\.test/);
  assert.match(rendered, new RegExp(`dog walking No default in force From ${NEXT_MONTH}: PawSpace 35%`));
  assert.match(rendered, new RegExp(`grooming PawSpace 30% since ${TODAY} · Set automatically at 30%, needs approval Proposed: PawSpace 20% from ${NEXT_MONTH}, by finance\\.maker@pawspace\\.test Approve Turn down`));
  assert.match(rendered, new RegExp(`Service default · pet sitting · PawSpace 30% since ${TODAY} · Set automatically at 30%, needs approval Approve`));

  // Idempotent: loading the screen again seeds nothing more.
  const count = () => sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms").get().n;
  const after = count();
  await read();
  assert.equal(count(), after);

  // The payout engine uses the seeded default.
  booking(sqlite, { id: "BK-SIT", providerId: "PRV-SIT", service: "pet_sitting" });
  assert.deepEqual(await payoutOf(db, "BK-SIT"), [700, 300, 54, "service_default"], "Rs 1,000 at PawSpace 30%: provider 700, commission 300, GST 54");
});

test("changing a service default needs a second person, is never back-dated, and one control sets every service", async () => {
  const { sqlite, db } = defaultsWorld();
  await actors(sqlite, db);
  await activeTerm(db, { serviceCode: "boarding", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-BRD" });
  const { route, post, read } = await partnerFinance();
  await read();
  booking(sqlite, { id: "BK-BRD-NOW", providerId: "PRV-ANY", service: "boarding" });
  booking(sqlite, { id: "BK-BRD-LATER", providerId: "PRV-ANY", service: "boarding", day: LATER });
  assert.deepEqual(await payoutOf(db, "BK-BRD-NOW"), [700, 300, 54, "service_default"]);
  const drafts = () => sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms WHERE provider_id IS NULL AND status='draft'").get().n;

  const backdated = await post(MAKER, { action: "propose_service_default", serviceCode: "boarding", pawspaceCommissionPercent: 25, effectiveFrom: YESTERDAY, reason: "Lower boarding default" });
  assert.equal(backdated.status, 400);
  assert.equal((await backdated.json()).error, `A service default cannot be back-dated: choose ${TODAY} or a later date (you entered ${YESTERDAY}).`);
  const tooHigh = await post(MAKER, { action: "propose_service_default", serviceCode: "boarding", pawspaceCommissionPercent: 45, effectiveFrom: TODAY, reason: "Higher boarding default" });
  assert.equal(tooHigh.status, 400);
  assert.equal((await tooHigh.json()).error, "PawSpace's commission for boarding cannot be above 40% of the amount paid (you entered 45%).");
  assert.equal(drafts(), 0, "a refused proposal saves nothing");

  const proposed = await post(MAKER, { action: "propose_service_default", serviceCode: "boarding", pawspaceCommissionPercent: 25, effectiveFrom: TODAY, reason: "Lower boarding default" });
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const draftId = (await proposed.json()).data.drafts[0].termId;
  assert.deepEqual(await payoutOf(db, "BK-BRD-NOW"), [700, 300, 54, "service_default"], "a proposal alone changes nothing");
  const own = await post(MAKER, { action: "approve_service_default", termIds: [draftId], approvalReference: "FIN-APR-DEF-1" });
  assert.equal(own.status, 409);
  assert.match((await own.json()).error, /Maker\/checker: the person who proposed a default commission cannot approve it/);
  assert.deepEqual(await payoutOf(db, "BK-BRD-NOW"), [700, 300, 54, "service_default"]);
  const approved = await post(CHECKER, { action: "approve_service_default", termIds: [draftId], approvalReference: "FIN-APR-DEF-1" });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.deepEqual(await payoutOf(db, "BK-BRD-NOW"), [750, 250, 45, "service_default"], "Rs 1,000 at PawSpace 25%: provider 750, commission 250, GST 45");
  const again = await post(CHECKER, { action: "approve_service_default", termIds: [draftId], approvalReference: "FIN-APR-DEF-1" });
  assert.equal(again.status, 200, "repeating the same approval is idempotent");
  assert.equal((await again.json()).data.duplicatePrevented, true);

  // One control for every service at once, through the screen's own requests, still maker-checker.
  const panel = await import("../app/team/finance/partners/commission-defaults-panel.tsx");
  const { sendTermsRequest } = await import("../app/team/finance/partners/commercial-terms-panel.tsx");
  const fetchAs = (email) => async (url, init) => url === "/api/partner-finance" ? route.POST(asActor(email, url, { method: "POST", body: init.body })) : new Response("not found", { status: 404 });
  assert.deepEqual(panel.serviceDefaultProblems({ serviceCode: "all", pawspaceCommissionPercent: "20", effectiveFrom: YESTERDAY, reason: "Owner lowered every default" }, TODAY), [`A service default cannot be back-dated: choose ${TODAY} or a later date (you entered ${YESTERDAY}).`], "the screen refuses what the server refuses");
  const all = await sendTermsRequest(fetchAs(OTHER), panel.serviceDefaultProposeRequest({ serviceCode: "all", pawspaceCommissionPercent: "20", effectiveFrom: LATER, reason: "Owner lowered every default" }));
  assert.equal(all.ok, true, all.error);
  assert.deepEqual(all.data.drafts.map((d) => [d.serviceCode, d.pawspaceCommissionPercent]), COMMISSION_SERVICES.map((code) => [code, 20]));
  const allIds = all.data.drafts.map((d) => d.termId);
  const selfApproved = await sendTermsRequest(fetchAs(OTHER), panel.serviceDefaultApproveRequest(allIds, "FIN-APR-ALL"));
  assert.equal(selfApproved.ok, false);
  const checked = await sendTermsRequest(fetchAs(CHECKER), panel.serviceDefaultApproveRequest(allIds, "FIN-APR-ALL"));
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(await payoutOf(db, "BK-BRD-NOW"), [750, 250, 45, "service_default"], "bookings before the new date keep the default in force");
  assert.deepEqual(await payoutOf(db, "BK-BRD-LATER"), [800, 200, 36, "service_default"], "from its start date every service is at 20%");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms WHERE provider_id IS NULL AND status='active' AND effective_from=? AND provider_share_pct=0.8 AND approved_by=?").get(LATER, CHECKER).n, 6);

  // A change whose start date passed while it waited is not approved: it would be back-dated.
  const stale = await post(MAKER, { action: "propose_service_default", serviceCode: "pet_taxi", pawspaceCommissionPercent: 35, effectiveFrom: TODAY, reason: "Taxi default review" });
  const staleId = (await stale.json()).data.drafts[0].termId;
  sqlite.prepare("UPDATE provider_commercial_terms SET effective_from=? WHERE id=?").run(YESTERDAY, staleId);
  const late = await post(CHECKER, { action: "approve_service_default", termIds: [staleId], approvalReference: "FIN-APR-LATE" });
  assert.equal(late.status, 409);
  assert.match((await late.json()).error, /was to start on .*, which has passed, and a default is never back-dated/);
  // The generic terms API holds the same rule for service defaults.
  const termsApi = await import("../app/api/provider-commercial-terms/route.ts");
  const api = (email, body) => termsApi.POST(asActor(email, "/api/provider-commercial-terms", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await api(MAKER, { action: "save_term", serviceCode: "boarding", engagementModel: "commission_standard", providerSharePct: 0.8, effectiveFrom: YESTERDAY, reason: "Back-dated default through the API" })).status, 400);
  assert.equal((await api(CHECKER, { action: "activate_term", termId: staleId, approvalReference: "FIN-APR-API" })).status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(staleId).status, "draft");
  // A draft the system made is never approved by one person, on this screen or through the terms API.
  const systemDraft = await terms.saveCommercialTerm(db, { serviceCode: "dog_walking", engagementModel: "commission_standard", providerSharePct: 0.75, effectiveFrom: LATER, reason: "Automatic default draft", actorId: SEED_MAKER });
  const bySystem = await post(CHECKER, { action: "approve_service_default", termIds: [systemDraft.id], approvalReference: "FIN-APR-SYS" });
  assert.equal(bySystem.status, 409);
  assert.match((await bySystem.json()).error, /The system made this change, not a person, so one person cannot approve it/);
  const bySystemApi = await api(CHECKER, { action: "activate_term", termId: systemDraft.id, approvalReference: "FIN-APR-SYS" });
  assert.equal(bySystemApi.status, 409);
  assert.match((await bySystemApi.json()).error, /The system made this change, not a person/);
  assert.equal(sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(systemDraft.id).status, "draft");
  assert.deepEqual(audits(sqlite, "partner.commission_default."), [["partner.commission_default.propose", MAKER, "completed"], ["partner.commission_default.approve", CHECKER, "completed"], ["partner.commission_default.approve", CHECKER, "completed"], ["partner.commission_default.propose", OTHER, "completed"], ["partner.commission_default.approve", CHECKER, "completed"], ["partner.commission_default.propose", MAKER, "completed"]]);
});

test("a booking resolves order override, then provider term, then service default, and Finance > Partners says so", async () => {
  const { sqlite, db } = defaultsWorld();
  await activeTerm(db, { serviceCode: "grooming", model: "commission_groomer", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-GRM" });
  booking(sqlite, { id: "BK-ORDER", providerId: "PRV-ORDER" });
  const source = async () => (await terms.providerShareForBooking(db, { bookingId: "BK-ORDER", serviceCode: "grooming", providerId: "PRV-ORDER" })).source;
  assert.deepEqual([...(await payoutOf(db, "BK-ORDER")), await source()], [700, 300, 54, "service_default", "service_default"]);
  await activeTerm(db, { serviceCode: "grooming", providerId: "PRV-ORDER", model: "commission_groomer", share: 0.75, effectiveFrom: "2026-01-01", reference: "FIN-APR-PRV" });
  assert.deepEqual([...(await payoutOf(db, "BK-ORDER")), await source()], [750, 250, 45, "provider", "provider"], "the provider's own term beats the service default");
  await terms.setOrderCommercialOverride(db, { bookingId: "BK-ORDER", providerSharePct: 0.8, reason: "Assignment-specific rate", actorId: MAKER });
  assert.equal(await source(), "provider", "a request alone changes nothing");
  await terms.approveOrderCommercialOverride(db, { bookingId: "BK-ORDER", actorId: CHECKER });
  assert.deepEqual([...(await payoutOf(db, "BK-ORDER")).slice(0, 3), await source()], [800, 200, 36, "order_override"], "an approved override beats the provider's term");

  const { default: PartnerFinancePage } = await import("../app/team/finance/partners/page.tsx");
  const text = pageText(renderToStaticMarkup(React.createElement(PartnerFinancePage)));
  assert.match(text, /Default commission by service/);
  assert.match(text, /Which commission a booking uses, in this order: an override a second person approved for that booking; otherwise the provider's own terms for that service; otherwise the service default\. Full-time providers never get a share\./);
  assert.match(text, /PawSpace's commission is 30% of the amount the customer paid for every commission service unless you change a service's default here \(10% to 40%\)\. A change starts today or later, never earlier\./);
});

test("a provider's engagement changes only when a second person approves it; the one-person write is refused with 409", async () => {
  const { sqlite, db } = defaultsWorld();
  await actors(sqlite, db);
  const setup = await import("../lib/provider-commission-setup.ts");
  const fullTime = await import("../lib/full-time-providers.ts");
  await capacityProvider(sqlite, db, "PRV-ENG", ["grooming", "boarding"]);
  await setup.draftProviderCommercialTerms(db, { providerId: "PRV-ENG", engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 30 }, { serviceCode: "boarding", pawspaceCommissionPercent: 20 }], effectiveFrom: "2026-01-01", reason: "Agreed at onboarding interview", actorId: MAKER });
  await setup.activateProviderCommercialTerms(db, { providerId: "PRV-ENG", approvalReference: "FIN-APR-ONB", actorId: CHECKER });
  booking(sqlite, { id: "BK-ENG", providerId: "PRV-ENG" });
  const engagement = () => [sqlite.prepare("SELECT engagement_model FROM provider_compensation_profiles WHERE provider_id='PRV-ENG'").get()?.engagement_model, sqlite.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id='PRV-ENG'").get().provider_model];
  assert.deepEqual(engagement(), ["commission", "commission"]);
  assert.deepEqual(await payoutOf(db, "BK-ENG"), [700, 300, 54, "provider"]);
  const { post } = await partnerFinance();

  // One person, through the older form: refused, and it says where the change is made now.
  const onePerson = await post(MAKER, { action: "save_provider_profile", providerId: "PRV-ENG", engagementModel: "full_time", reason: "Moved to a monthly contract" });
  assert.equal(onePerson.status, 409);
  const refusal = await onePerson.json();
  assert.match(refusal.error, /needs a second person\. On Finance > Partners, under Provider commercial terms, choose how the provider is engaged and save it for approval; a different person then approves it/);
  assert.deepEqual(refusal.next, { propose: "propose_engagement_change", approve: "activate_provider_commercial_terms", bankAccount: "save_provider_bank_account" }, "API callers are pointed to the new flow");
  assert.deepEqual(engagement(), ["commission", "commission"]);
  assert.equal((await fullTime.fullTimeProviderIds(db)).has("PRV-ENG"), false);
  await assert.rejects(() => commission.saveProviderCompensationProfile(db, { providerId: "PRV-ENG", engagementModel: "full_time", reason: "Moved to a monthly contract", actor: MAKER }), (error) => error.status === 409 && /needs a second person/.test(error.message), "the library write is refused the same way");
  assert.deepEqual(engagement(), ["commission", "commission"]);

  // A proposal: nothing changes until a different person approves it.
  const proposed = await post(MAKER, { action: "propose_engagement_change", providerId: "PRV-ENG", engagement: "full_time", reason: "Moved to a monthly contract" });
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const proposal = (await proposed.json()).data;
  assert.deepEqual([proposal.from, proposal.to, proposal.status], ["commission", "full_time", "awaiting_approval"]);
  assert.deepEqual(proposal.drafts.map((d) => [d.serviceCode, d.engagementModel, d.providerSharePct]), [["boarding", "direct_employee", 0], ["grooming", "direct_employee", 0]]);
  assert.deepEqual(engagement(), ["commission", "commission"]);
  assert.deepEqual(await payoutOf(db, "BK-ENG"), [700, 300, 54, "provider"], "a proposal alone changes nothing");
  // One term of the set alone, through the terms API, is refused: it would leave the provider half full-time with the engagement unrecorded.
  const termsApi = await import("../app/api/provider-commercial-terms/route.ts");
  const single = await termsApi.POST(asActor(CHECKER, "/api/provider-commercial-terms", { method: "POST", body: JSON.stringify({ action: "activate_term", termId: proposal.drafts[0].termId, approvalReference: "FIN-APR-ONE" }) }));
  assert.equal(single.status, 409);
  assert.match((await single.json()).error, /a provider's terms are approved together so the terms and how the provider is engaged change at the same time\. Approve the provider's whole set instead: Approve and activate on Finance > Partners \(activate_provider_terms\)/);
  assert.deepEqual(engagement(), ["commission", "commission"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms WHERE provider_id='PRV-ENG' AND status='draft'").get().n, 2, "the whole set still waits");
  assert.deepEqual(await payoutOf(db, "BK-ENG"), [700, 300, 54, "provider"]);
  const termIds = proposal.drafts.map((d) => d.termId);
  const same = await post(MAKER, { action: "activate_provider_commercial_terms", providerId: "PRV-ENG", approvalReference: "FIN-APR-ENG", termIds });
  assert.equal(same.status, 409);
  assert.match((await same.json()).error, /the drafter cannot activate their own commercial term/);
  assert.deepEqual(engagement(), ["commission", "commission"]);
  const approved = await post(CHECKER, { action: "activate_provider_commercial_terms", providerId: "PRV-ENG", approvalReference: "FIN-APR-ENG", termIds });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.deepEqual(engagement(), ["full_time", "full_time"], "the payout profile and the capacity profile change together");
  assert.equal((await fullTime.fullTimeProviderIds(db)).has("PRV-ENG"), true);
  const own = await terms.computeOrderPayout(db, { bookingId: "BK-ENG", actorId: CHECKER, persist: false });
  assert.deepEqual([own.supplyModel, own.providerNetPayout, own.pawspaceGstOnOrder], ["own_supply", 0, 180], "full-time: own supply, GST 18% of the full Rs 1,000");
  const proposedAudit = sqlite.prepare("SELECT actor_id,detail_json FROM commercial_terms_audit WHERE action='engagement_change_proposed' AND term_id='ENGAGEMENT-PRV-ENG'").get();
  assert.deepEqual([proposedAudit.actor_id, JSON.parse(proposedAudit.detail_json).from, JSON.parse(proposedAudit.detail_json).to], [MAKER, "commission", "full_time"]);
  assert.deepEqual(audits(sqlite, "partner.compensation.profile").concat(audits(sqlite, "partner.engagement.")), [["partner.compensation.profile", MAKER, "rejected"], ["partner.engagement.propose", MAKER, "completed"]]);
  assert.deepEqual(audits(sqlite, "partner.commercial_terms.activate"), [["partner.commercial_terms.activate", CHECKER, "completed"]]);

  // Saving a bank account does not set an engagement on one person's say-so: a new payout profile records what the provider already is.
  await capacityProvider(sqlite, db, "PRV-FT-BANK", ["grooming"], "full_time");
  const bank = await post(MAKER, { action: "save_provider_bank_account", providerId: "PRV-FT-BANK", razorpayxContactId: "cont_test_bank", reason: "Bank details from onboarding" });
  assert.equal(bank.status, 200, await bank.clone().text());
  assert.equal(sqlite.prepare("SELECT engagement_model FROM provider_compensation_profiles WHERE provider_id='PRV-FT-BANK'").get().engagement_model, "full_time");
});

test("a concurrent change during activation leaves nothing half-applied", async () => {
  const { sqlite, db } = defaultsWorld();
  const setup = await import("../lib/provider-commission-setup.ts");
  const statuses = (providerId) => sqlite.prepare("SELECT id,service_code,status FROM provider_commercial_terms WHERE provider_id=? ORDER BY service_code,version").all(providerId).map((r) => [r.service_code, r.status]);

  // 1. A provider's set: another Finance user replaces the grooming term while the boarding term is being activated.
  await capacityProvider(sqlite, db, "PRV-RACE", ["boarding", "grooming"]);
  await setup.draftProviderCommercialTerms(db, { providerId: "PRV-RACE", engagement: "full_time", services: [{ serviceCode: "boarding" }, { serviceCode: "grooming" }], reason: "Moving to a monthly contract", actorId: MAKER });
  const shown = (await setup.providerCommercialTermsView(db, { providerId: "PRV-RACE" })).awaitingApproval.map((t) => t.termId);
  const groomingDraft = sqlite.prepare("SELECT id FROM provider_commercial_terms WHERE provider_id='PRV-RACE' AND service_code='grooming' AND status='draft'").get().id;
  let restore = concurrentChangeBeforeActivation(db, () => {
    const at = Date.now();
    sqlite.prepare("UPDATE provider_commercial_terms SET status='withdrawn',updated_at=? WHERE id=?").run(at, groomingDraft);
    sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,effective_from,reason,created_by,created_at,updated_at) VALUES ('PCT-RACE-NEW','grooming','PRV-RACE',9,'draft','commission_groomer',0.75,'none',0.18,1,?,'replacement proposal',?,?,?)").run(TODAY, OTHER, at, at);
  });
  let refusal = null;
  try {
    await setup.activateProviderCommercialTerms(db, { providerId: "PRV-RACE", approvalReference: "FIN-APR-RACE", actorId: CHECKER, termIds: shown }).catch((error) => { refusal = error; });
  } finally { assert.equal(restore(), true, "the change landed between the checks and the activation"); }
  assert.deepEqual(statuses("PRV-RACE"), [["boarding", "draft"], ["grooming", "withdrawn"], ["grooming", "draft"]], "no term of the set went live");
  assert.equal(refusal?.status, 409);
  assert.match(refusal.message, /The terms waiting for approval changed after you loaded them/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM commercial_terms_audit WHERE action='activated'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id='PRV-RACE'").get().provider_model, "commission", "the engagement did not change either");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='provider_compensation_profiles'").get().n === 0 || !sqlite.prepare("SELECT 1 FROM provider_compensation_profiles WHERE provider_id='PRV-RACE'").get(), true);
  // The approver reloads and approves what is waiting now: all of it applies.
  const reviewed = (await setup.providerCommercialTermsView(db, { providerId: "PRV-RACE" })).awaitingApproval.map((t) => t.termId);
  await assert.rejects(() => setup.activateProviderCommercialTerms(db, { providerId: "PRV-RACE", approvalReference: "FIN-APR-RACE", actorId: OTHER, termIds: reviewed }), /the drafter cannot activate/);
  const done = await setup.activateProviderCommercialTerms(db, { providerId: "PRV-RACE", approvalReference: "FIN-APR-RACE-2", actorId: CHECKER, termIds: reviewed });
  assert.deepEqual(done.activated.map((t) => [t.serviceCode, t.status]), [["boarding", "active"], ["grooming", "active"]]);

  // 2. One term: the draft is replaced after it was loaded. The default in force must not be superseded by a withdrawn draft.
  const inForce = await activeTerm(db, { serviceCode: "pet_sitting", share: 0.7, effectiveFrom: TODAY, reference: "FIN-APR-SIT" });
  const replaced = await terms.saveCommercialTerm(db, { serviceCode: "pet_sitting", engagementModel: "commission_standard", providerSharePct: 0.75, effectiveFrom: TODAY, reason: "Sitting default review", actorId: MAKER });
  restore = concurrentChangeBeforeActivation(db, () => { sqlite.prepare("UPDATE provider_commercial_terms SET status='withdrawn',updated_at=? WHERE id=?").run(Date.now(), replaced.id); });
  refusal = null;
  try {
    await terms.activateCommercialTerm(db, { termId: replaced.id, approvalReference: "FIN-APR-SIT-2", actorId: CHECKER }).catch((error) => { refusal = error; });
  } finally { assert.equal(restore(), true); }
  assert.deepEqual([inForce, replaced.id].map((id) => sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(id).status), ["active", "withdrawn"], "the default in force stays; the withdrawn draft never goes live");
  assert.equal(refusal?.status, 409);

  // 3. "Every service at once": one default replaced while the set is being approved leaves every default as it was.
  const { post } = await partnerFinance();
  await actors(sqlite, db);
  const all = await post(MAKER, { action: "propose_service_default", allServices: true, pawspaceCommissionPercent: 25, effectiveFrom: LATER, reason: "Owner lowered every default" });
  assert.equal(all.status, 201, await all.clone().text());
  const allIds = (await all.json()).data.drafts.map((d) => d.termId);
  restore = concurrentChangeBeforeActivation(db, () => { sqlite.prepare("UPDATE provider_commercial_terms SET status='withdrawn',updated_at=? WHERE id=?").run(Date.now(), allIds.at(-1)); });
  try {
    const refused = await post(CHECKER, { action: "approve_service_default", termIds: allIds, approvalReference: "FIN-APR-ALL" });
    assert.equal(refused.status, 409);
  } finally { assert.equal(restore(), true); }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms WHERE provider_id IS NULL AND status='active' AND effective_from=?").get(LATER).n, 0, "no service got the new default");
});

test("a carried-over legacy term shows that it needs re-approval, a second person re-approves it, audited, and payouts never stop", async () => {
  const { sqlite, db } = defaultsWorld();
  await actors(sqlite, db);
  await capacityProvider(sqlite, db, "PRV-LEG", ["grooming"]);
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,status,reason,updated_by,created_at,updated_at) VALUES ('PRV-LEG','commission','percent',70,'active','older profile',?,?,?)").run(LEGACY_SETTER, Date.parse("2026-03-01T00:00:00Z"), NOW);
  await commission.migrateLegacyCommissionProfiles(db);
  const carried = sqlite.prepare("SELECT * FROM provider_commercial_terms WHERE provider_id='PRV-LEG'").get();
  assert.deepEqual([carried.status, carried.approved_by, carried.created_by], ["active", "system:legacy-commission-migration", LEGACY_SETTER]);
  booking(sqlite, { id: "BK-LEG", providerId: "PRV-LEG" });
  assert.deepEqual(await payoutOf(db, "BK-LEG"), [700, 300, 54, "provider"], "payouts use the carried-over term while it waits");

  const { post, read } = await partnerFinance();
  const listed = (await read()).commercialTerms;
  assert.ok(Array.isArray(listed.approvalNeeded), "Finance > Partners lists the terms in use that wait for a person's approval");
  const entry = listed.approvalNeeded.find((t) => t.termId === carried.id);
  assert.deepEqual([entry.providerId, entry.serviceCode, entry.pawspaceCommissionPercent, entry.label], ["PRV-LEG", "grooming", 30, "Carried over, needs re-approval"]);
  assert.equal(listed.providers.find((p) => p.providerId === "PRV-LEG").terms[0].needsPersonApproval, "Carried over, needs re-approval");
  const { default: CommissionDefaultsPanel } = await import("../app/team/finance/partners/commission-defaults-panel.tsx");
  assert.match(pageText(renderToStaticMarkup(React.createElement(CommissionDefaultsPanel, { defaults: listed.defaults, approvalNeeded: listed.approvalNeeded }))), /PRV-LEG · grooming · PawSpace 30% since \d{4}-\d{2}-\d{2} · Carried over, needs re-approval Approve/, "the badge and the re-approve action show in Finance");
  const setup = await import("../lib/provider-commission-setup.ts");
  assert.equal((await setup.providerCommercialTermsView(db, { providerId: "PRV-LEG" })).services[0].active.needsPersonApproval, "Carried over, needs re-approval");

  const setter = await post(LEGACY_SETTER, { action: "reapprove_commercial_term", termId: carried.id, approvalReference: "FIN-REAPR-1" });
  assert.equal(setter.status, 409);
  assert.match((await setter.json()).error, /A second person must re-approve this term: the person who set it cannot approve it/);
  const noReference = await post(CHECKER, { action: "reapprove_commercial_term", termId: carried.id, approvalReference: "" });
  assert.equal(noReference.status, 400);
  const reapproved = await post(CHECKER, { action: "reapprove_commercial_term", termId: carried.id, approvalReference: "FIN-REAPR-1" });
  assert.equal(reapproved.status, 200, await reapproved.clone().text());
  const after = sqlite.prepare("SELECT * FROM provider_commercial_terms WHERE id=?").get(carried.id);
  assert.deepEqual([after.status, after.approved_by, after.approval_reference, after.provider_share_pct, after.effective_from, after.engagement_model], ["active", CHECKER, "FIN-REAPR-1", carried.provider_share_pct, carried.effective_from, carried.engagement_model], "only who approved it changes");
  const audit = sqlite.prepare("SELECT actor_id,detail_json FROM commercial_terms_audit WHERE term_id=? AND action='reapproved'").all(carried.id);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor_id, JSON.parse(audit[0].detail_json).previousApprovedBy, JSON.parse(audit[0].detail_json).approvalReference], [CHECKER, "system:legacy-commission-migration", "FIN-REAPR-1"]);
  assert.deepEqual(audits(sqlite, "partner.commercial_terms.reapprove"), [["partner.commercial_terms.reapprove", CHECKER, "completed"]]);
  assert.deepEqual(await payoutOf(db, "BK-LEG"), [700, 300, 54, "provider"]);
  const again = await post(CHECKER, { action: "reapprove_commercial_term", termId: carried.id, approvalReference: "FIN-REAPR-1" });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM commercial_terms_audit WHERE term_id=? AND action='reapproved'").get(carried.id).n, 1);
  assert.equal((await read()).commercialTerms.approvalNeeded.some((t) => t.termId === carried.id), false, "the badge is gone");
});

test("a funeral booking's override can be any share from 0% to 100%; a grooming override stays inside 10-40%", async () => {
  const { sqlite, db } = defaultsWorld();
  await actors(sqlite, db);
  await activeTerm(db, { serviceCode: "funeral_memorial", model: "funeral_exempt", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-FUN" });
  await activeTerm(db, { serviceCode: "grooming", model: "commission_groomer", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-GRM" });
  booking(sqlite, { id: "BK-FUN", providerId: "PRV-FUN", service: "funeral_memorial" });
  booking(sqlite, { id: "BK-GRM", providerId: "PRV-GRM" });
  const { post } = await partnerFinance();
  const ask = (bookingId, percent) => post(MAKER, { action: "request_order_override", bookingId, pawspaceCommissionPercent: percent, reason: "Special rate for this assignment" });

  for (const [percent, message] of [[50, "cannot be above 40% of the amount paid (you entered 50%)."], [5, "cannot be below 10% of the amount paid (you entered 5%)."]]) {
    const refused = await ask("BK-GRM", percent);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, `PawSpace's commission for booking BK-GRM ${message}`);
  }
  const funeral = await ask("BK-FUN", 50);
  assert.equal(funeral.status, 201, await funeral.clone().text());
  const approved = await post(CHECKER, { action: "approve_order_override", bookingId: "BK-FUN" });
  assert.equal(approved.status, 200, await approved.clone().text());
  const split = await terms.computeOrderPayout(db, { bookingId: "BK-FUN", actorId: CHECKER, persist: false });
  assert.deepEqual([split.providerNetPayout, split.platformFee, split.platformGst, split.gstExempt], [500, 500, 0, true], "Rs 1,000 funeral at 50/50: GST exempt");
  for (const percent of [0, 5, 100]) assert.equal((await ask("BK-FUN", percent)).status, 201, `PawSpace ${percent}% on a funeral booking is accepted`);
  const beyond = await ask("BK-FUN", 120);
  assert.equal(beyond.status, 400);
  assert.equal((await beyond.json()).error, "PawSpace's share for booking BK-FUN must be from 0% to 100% of the amount paid (you entered 120%).");

  // The older confirm-and-approve steps follow the same rule.
  completedCommissionJob(sqlite, { id: "BK-FUN-OLD", providerId: "PRV-FUN", service: "funeral_memorial" });
  completedCommissionJob(sqlite, { id: "BK-GRM-OLD", providerId: "PRV-GRM" });
  await commission.syncCompletedCommissionOrders(db);
  const olderFuneral = await post(MAKER, { action: "override_order_commission", bookingId: "BK-FUN-OLD", pawspaceCommissionPercent: 60, reason: "Case handled mostly by PawSpace" });
  assert.equal(olderFuneral.status, 201, await olderFuneral.clone().text());
  const olderApproved = await post(CHECKER, { action: "approve_order_override", bookingId: "BK-FUN-OLD" });
  assert.deepEqual((await olderApproved.json()).data.olderApprovalSteps, { commissionValue: 40, commissionAmount: 400 });
  const olderGrooming = await post(MAKER, { action: "override_order_commission", bookingId: "BK-GRM-OLD", pawspaceCommissionPercent: 60, reason: "Special rate for this order" });
  assert.equal(olderGrooming.status, 400);

  // The screen's form takes 0-100 and says which range applies where.
  const { default: PartnerFinancePage } = await import("../app/team/finance/partners/page.tsx");
  const html = renderToStaticMarkup(React.createElement(PartnerFinancePage));
  assert.match(html, /type="number" min="0" max="100" step="0.5" value="30"/);
  assert.match(pageText(html), /10% to 40% on a commission service; any share from 0% to 100% on a funeral or memorial booking/);
});

test("an activation, re-approval or rejection the database does not confirm is never reported as done", async () => {
  const { sqlite, db } = defaultsWorld();
  const defaults = await import("../lib/service-commission-defaults.ts");
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "boarding", engagementModel: "commission_standard", providerSharePct: 0.7, effectiveFrom: TODAY, reason: "Boarding default", actorId: MAKER });
  const waiting = await terms.saveCommercialTerm(db, { serviceCode: "pet_sitting", engagementModel: "commission_standard", providerSharePct: 0.75, effectiveFrom: TODAY, reason: "Sitting default review", actorId: MAKER });
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('PCT-CARRIED','grooming','PRV-CARRIED',1,'active','commission_groomer',0.7,'none',0.18,1,'2026-03-01','carried over',?,'system:legacy-commission-migration','LEGACY-PROFILE-PRV-CARRIED',?,?)").run(LEGACY_SETTER, NOW, NOW);
  // A driver that answers without a change count, and applied nothing.
  const original = db.batch;
  db.batch = async (list) => list.map(() => ({ success: true }));
  try {
    await assert.rejects(() => terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "FIN-APR-X", actorId: CHECKER }), (error) => error.status === 409);
    await assert.rejects(() => terms.reapproveCommercialTerm(db, { termId: "PCT-CARRIED", approvalReference: "FIN-REAPR-X", actorId: CHECKER }), (error) => error.status === 409);
    await assert.rejects(() => defaults.rejectServiceCommissionDefaults(db, { termIds: [waiting.id], actorId: CHECKER }), (error) => error.status === 409);
  } finally { db.batch = original; }
  assert.deepEqual([draft.id, waiting.id].map((id) => sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(id).status), ["draft", "draft"]);
  assert.equal(sqlite.prepare("SELECT approved_by FROM provider_commercial_terms WHERE id='PCT-CARRIED'").get().approved_by, "system:legacy-commission-migration");
});

test("the default's start date comes from the server's today, so the server and the browser render the same page", async () => {
  const { default: CommissionDefaultsPanel } = await import("../app/team/finance/partners/commission-defaults-panel.tsx");
  // A server date far from the test machine's clock on purpose: the page must show the server's, not the browser's.
  assert.match(renderToStaticMarkup(React.createElement(CommissionDefaultsPanel, { defaults: { services: [], today: "2031-01-15" } })), /<input type="date" min="2031-01-15" value="2031-01-15"\/>/);
  assert.match(renderToStaticMarkup(React.createElement(CommissionDefaultsPanel, {})), /<input type="date" value=""\/>/, "before the data arrives the date is empty, not the local clock");
});

test("the Worker's scheduled tick seeds a missing default, reports a failure, logs a locked month, and costs one SELECT once seeded", async () => {
  const fs = await import("node:fs");
  const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const fanout = worker.indexOf("=await Promise.allSettled([");
  const seed = worker.indexOf("seedMissingServiceCommissionDefaults(env.DB)", fanout), payout = worker.indexOf("runProviderPayoutQueueSweep(env.DB", fanout);
  assert.ok(fanout > 0 && seed > fanout && payout > seed && !worker.slice(seed, payout).includes("),\n        run"), "the seed is in the scheduled fan-out, right before the payout queue sweep");
  assert.match(worker, /,partnerHeartbeat,commissionDefaults,providerPayoutQueue\]=await Promise\.allSettled\(\[/);
  assert.match(worker, /if\(commissionDefaults\.status==="rejected"\)errors\.push\(`commission defaults: /, "a failing seed is reported, not swallowed");
  assert.match(worker, /else if\(commissionDefaults\.value\.blocked\)console\.warn\(`\[scheduled\] commission defaults not seeded: \$\{commissionDefaults\.value\.blocked\}`\)/, "a locked month is logged");

  // What the tick runs.
  const { sqlite, db } = defaultsWorld();
  const defaults = await import("../lib/service-commission-defaults.ts");
  const month = TODAY.slice(0, 7), termCount = () => sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms").get().n;
  sqlite.exec("CREATE TABLE finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','[]',?,?,?)").run(month, NOW, CHECKER, NOW);
  assert.deepEqual(await defaults.seedMissingServiceCommissionDefaults(db), { seeded: [], blocked: `The books for ${month} are closed, so commission terms cannot start in that month. Choose a start date in an open month.` });
  assert.equal(termCount(), 0, "a locked month stops the seed before it writes anything");
  sqlite.prepare("UPDATE finance_close_periods SET status='open'").run();
  assert.deepEqual((await defaults.seedMissingServiceCommissionDefaults(db)).seeded.map((s) => s.serviceCode), COMMISSION_SERVICES);
  const after = termCount(), statements = [], prepare = db.prepare;
  db.prepare = (sql) => { statements.push(sql); return prepare(sql); };
  try { assert.deepEqual(await defaults.seedMissingServiceCommissionDefaults(db), { seeded: [], blocked: null }); } finally { db.prepare = prepare; }
  assert.deepEqual(statements.map((sql) => sql.trim().split(/\s+/)[0].toUpperCase()), ["SELECT"], "once every service has its default, a tick is one SELECT");
  assert.equal(termCount(), after);
});
