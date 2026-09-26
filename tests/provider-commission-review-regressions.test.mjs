/*
 * Review regressions for owner decision 8 (provider commission at onboarding, one commission system, 10-40%).
 *
 *  1. Terms are effective-dated. Activating a rate that starts next month must not take the current rate away from
 *     this month's bookings (they fell to the service default, or failed completion with "configuration required").
 *  2. The checker approves exactly the proposal they were shown: a proposal replaced after they loaded it is not
 *     activated on their click.
 *  3. A mistyped start date is refused before the provider's waiting proposal is withdrawn.
 *  4. Only funeral / memorial can use the GST-exempt model (owner decisions 2 and 4), on a term or an order override.
 *  5. An order override for a booking that does not exist is refused.
 *  6. The preview shows no GST for a full-time funeral provider, exactly as the engine computes it.
 *  7. A commission provider who also offers funeral is shown and recorded as a commission provider.
 *  8. An approved override keeps the older confirm-and-approve steps in step: own supply leaves nothing to pay there, and
 *     a booking already confirmed there cannot be overridden (the override would change the split but not the payment).
 *  9. A rejection that loses a race with an approval is refused, and writes no "rejected" audit row.
 *
 * Everything EXECUTES the real modules and routes on an in-memory SQLite database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__COMMISSION_REVIEW_DB__", "__COMMISSION_REVIEW_ENV__");
process.env.FORBID_PRODUCTION = "true";
const terms = await import("../lib/provider-commercial-terms.ts");

const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const MAKER = "finance.maker@pawspace.test", CHECKER = "finance.checker@pawspace.test", OTHER = "finance.other@pawspace.test";
const NOW = Date.now();
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function reviewWorld() {
  const { sqlite, db } = world("__COMMISSION_REVIEW_DB__", "__COMMISSION_REVIEW_ENV__", SANDBOX);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db };
}
function booking(sqlite, { id, providerId, service = "boarding", total = 1000, day, status = "confirmed" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,scheduled_start,created_at,updated_at) VALUES (?,?,'blr',?,?,?,?,'INR',?,?,?)").run(id, `CUS-${id}`, service, providerId, status, total, `${day}T05:00:00.000Z`, NOW, NOW);
}
async function activeTerm(db, { serviceCode, providerId = null, model = "commission_standard", share, effectiveFrom, reference }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode, providerId, engagementModel: model, providerSharePct: share, effectiveFrom, reason: `${serviceCode} commercial terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: reference, actorId: CHECKER });
  return draft.id;
}
const payoutOf = async (db, bookingId) => { const p = await terms.computeOrderPayout(db, { bookingId, actorId: CHECKER, persist: false }); return [p.providerNetPayout, p.platformFee, p.platformGst, p.termSource]; };

test("a rate agreed today for next month does not take the current rate away from bookings before it", async () => {
  const { sqlite, db } = reviewWorld();
  // The provider's own rate: PawSpace 20% from January.
  const current = await activeTerm(db, { serviceCode: "boarding", providerId: "PRV-DATED", share: 0.8, effectiveFrom: "2026-01-01", reference: "FIN-APR-JAN" });
  // A new rate, PawSpace 25%, approved now but starting on 1 November.
  const next = await activeTerm(db, { serviceCode: "boarding", providerId: "PRV-DATED", share: 0.75, effectiveFrom: "2026-11-01", reference: "FIN-APR-NOV" });
  booking(sqlite, { id: "BK-OCT", providerId: "PRV-DATED", day: "2026-10-10" });
  booking(sqlite, { id: "BK-NOV", providerId: "PRV-DATED", day: "2026-11-10" });
  assert.deepEqual(await payoutOf(db, "BK-OCT"), [800, 200, 36, "provider"], "an October booking keeps the January rate (it had no rate at all before the fix)");
  assert.deepEqual(await payoutOf(db, "BK-NOV"), [750, 250, 45, "provider"], "a November booking gets the new rate");
  // A replacement starting on or before the current rate's date still replaces it.
  const replacement = await activeTerm(db, { serviceCode: "boarding", providerId: "PRV-DATED", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-FIX" });
  const status = (id) => sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(id).status;
  assert.deepEqual([status(current), status(next), status(replacement)], ["superseded", "superseded", "active"]);
  assert.deepEqual(await payoutOf(db, "BK-OCT"), [700, 300, 54, "provider"]);
  assert.deepEqual(await payoutOf(db, "BK-NOV"), [700, 300, 54, "provider"]);
  // Service defaults are effective-dated the same way.
  await activeTerm(db, { serviceCode: "dog_walking", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-WALK" });
  await activeTerm(db, { serviceCode: "dog_walking", share: 0.65, effectiveFrom: "2026-12-01", reference: "FIN-APR-WALK-DEC" });
  booking(sqlite, { id: "BK-WALK", providerId: "PRV-ANY", service: "dog_walking", day: "2026-10-20" });
  assert.deepEqual(await payoutOf(db, "BK-WALK"), [700, 300, 54, "service_default"]);
});

test("the provider's screen shows the rate in force today and the one scheduled to start later", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { db } = reviewWorld();
  const past = isoDay(NOW - 30 * DAY), future = isoDay(NOW + 30 * DAY);
  await activeTerm(db, { serviceCode: "boarding", providerId: "PRV-VIEW", share: 0.8, effectiveFrom: past, reference: "FIN-APR-NOW" });
  await activeTerm(db, { serviceCode: "boarding", providerId: "PRV-VIEW", share: 0.75, effectiveFrom: future, reference: "FIN-APR-LATER" });
  const view = await setup.providerCommercialTermsView(db, { providerId: "PRV-VIEW" });
  const boarding = view.services.find((s) => s.serviceCode === "boarding");
  assert.equal(boarding.active.pawspaceCommissionPercent, 20, "in force today");
  assert.deepEqual(boarding.scheduled.map((t) => [t.pawspaceCommissionPercent, t.effectiveFrom]), [[25, future]]);
});

test("the checker activates exactly the proposal they were shown", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = reviewWorld();
  const propose = (percent, actorId = MAKER) => setup.draftProviderCommercialTerms(db, { providerId: "PRV-SEEN", engagement: "commission", services: [{ serviceCode: "boarding", pawspaceCommissionPercent: percent }], reason: "Agreed at onboarding interview", actorId });
  await propose(30);
  const shown = (await setup.providerCommercialTermsView(db, { providerId: "PRV-SEEN" })).awaitingApproval.map((t) => t.termId);
  // The proposal is replaced after the checker loaded it.
  await propose(10, OTHER);
  await assert.rejects(() => setup.activateProviderCommercialTerms(db, { providerId: "PRV-SEEN", approvalReference: "FIN-APR-SEEN", actorId: CHECKER, termIds: shown }), (error) => error.status === 409 && /changed after you loaded them/.test(error.message));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms WHERE provider_id='PRV-SEEN' AND status='active'").get().n, 0, "nothing went live");
  // Reviewing the new proposal and approving it works.
  const reviewed = (await setup.providerCommercialTermsView(db, { providerId: "PRV-SEEN" })).awaitingApproval.map((t) => t.termId);
  const activated = await setup.activateProviderCommercialTerms(db, { providerId: "PRV-SEEN", approvalReference: "FIN-APR-SEEN", actorId: CHECKER, termIds: reviewed });
  assert.deepEqual(activated.activated.map((t) => t.pawspaceCommissionPercent), [10]);

  // Through the screens: the panel sends the drafts it showed, and the Finance route refuses a stale approval.
  const panel = await import("../app/team/finance/partners/commercial-terms-panel.tsx");
  const request = panel.providerTermsActivateRequest("finance", "PRV-ROUTE", "FIN-APR-22", ["PCT-OLD"]);
  assert.deepEqual(request, { url: "/api/partner-finance", body: { action: "activate_provider_commercial_terms", providerId: "PRV-ROUTE", approvalReference: "FIN-APR-22", termIds: ["PCT-OLD"] } });
  assert.deepEqual(panel.providerTermsActivateRequest("onboarding", "PRV-ROUTE", "FIN-APR-22", ["PCT-OLD"]).body.termIds, ["PCT-OLD"]);
  await seedActors(sqlite, db, [{ id: "USR-FIN-M", email: MAKER, role: "finance" }, { id: "USR-FIN-C", email: CHECKER, role: "finance" }]);
  const route = await import("../app/api/partner-finance/route.ts");
  const termsRoute = await import("../app/api/provider-commercial-terms/route.ts");
  const post = (handler, url, email, body) => handler.POST(asActor(email, url, { method: "POST", body: JSON.stringify(body) }));
  const saved = await post(route, "/api/partner-finance", MAKER, { action: "save_provider_commercial_terms", providerId: "PRV-ROUTE", engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 30 }], reason: "Agreed at onboarding interview" });
  assert.equal(saved.status, 201, await saved.clone().text());
  const draftId = (await saved.json()).data.drafts[0].termId;
  const stale = await post(route, "/api/partner-finance", CHECKER, request.body);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed after you loaded them/);
  const staleOnboarding = await post(termsRoute, "/api/provider-commercial-terms", CHECKER, { action: "activate_provider_terms", providerId: "PRV-ROUTE", approvalReference: "FIN-APR-22", termIds: ["PCT-OLD"] });
  assert.equal(staleOnboarding.status, 409);
  const fresh = await post(route, "/api/partner-finance", CHECKER, { ...request.body, termIds: [draftId] });
  assert.equal(fresh.status, 200, await fresh.clone().text());
  assert.equal(sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id=?").get(draftId).status, "active");
});

test("a mistyped start date is refused before the waiting proposal is withdrawn", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = reviewWorld();
  const propose = (effectiveFrom) => setup.draftProviderCommercialTerms(db, { providerId: "PRV-DATE", engagement: "commission", services: [{ serviceCode: "boarding" }], effectiveFrom, reason: "Agreed at onboarding interview", actorId: MAKER });
  await propose("2026-10-01");
  for (const bad of ["01/10/2026", "2026-02-30", "2026-13-01"]) await assert.rejects(() => propose(bad), (error) => error.status === 400 && /real date \(YYYY-MM-DD\)/.test(error.message));
  assert.deepEqual(sqlite.prepare("SELECT status,effective_from FROM provider_commercial_terms WHERE provider_id='PRV-DATE'").all().map((r) => [r.status, r.effective_from]), [["draft", "2026-10-01"]], "the earlier proposal is still waiting");
});

test("only funeral and memorial can use the GST-exempt model, on a term or on one booking", async () => {
  const { sqlite, db } = reviewWorld();
  const save = (serviceCode) => terms.saveCommercialTerm(db, { serviceCode, engagementModel: "funeral_exempt", providerSharePct: 0.7, effectiveFrom: "2026-01-01", reason: "Exempt model trial", actorId: MAKER });
  await assert.rejects(() => save("grooming"), (error) => error.status === 400 && /can only be used for funeral or memorial services/.test(error.message));
  await assert.rejects(() => save("boarding"), /can only be used for funeral or memorial services/);
  assert.equal((await save("funeral")).engagementModel, "funeral_exempt");
  assert.equal((await save("funeral_memorial")).engagementModel, "funeral_exempt");
  // One booking cannot be made GST exempt either.
  await activeTerm(db, { serviceCode: "grooming", model: "commission_groomer", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-GRM" });
  booking(sqlite, { id: "BK-GRM", providerId: "PRV-GRM", service: "grooming", day: "2026-10-10" });
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-GRM", engagementModel: "funeral_exempt", providerSharePct: 0.7, reason: "Make this booking exempt", actorId: MAKER }), /can only be used for funeral or memorial services/);
  assert.deepEqual(await payoutOf(db, "BK-GRM"), [700, 300, 54, "service_default"], "the grooming booking keeps its GST");
});

test("an order override for a booking that does not exist is refused", async () => {
  const { sqlite, db } = reviewWorld();
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-TYPO", providerSharePct: 0.8, reason: "Special rate for this order", actorId: MAKER }), (error) => error.status === 404 && /Booking BK-TYPO was not found/.test(error.message));
  await terms.ensureCommercialTermsTables(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM order_commercial_override_requests").get().n, 0);
});

test("the preview shows no GST for a full-time funeral provider, as the engine computes it", async () => {
  const range = await import("../lib/commission-range.ts");
  const setup = await import("../lib/provider-commission-setup.ts");
  const funeral = range.commissionPreview({ engagement: "full_time", serviceCode: "funeral" });
  assert.deepEqual([funeral.gst, funeral.pawspaceAfterGst], [0, 1000]);
  assert.match(funeral.sentence, /^On a Rs 1,000 booking: PawSpace keeps Rs 1,000 and pays no GST \(funeral and memorial are GST exempt\)\. The provider is paid a monthly fee/);
  assert.equal(range.commissionPreview({ engagement: "full_time", serviceCode: "grooming" }).gst, 180, "every other own-supply service still pays GST on the full amount");
  assert.equal(range.commissionPreview({ engagement: "commission", pawspaceCommissionPercent: 30, serviceCode: "funeral" }).gst, 0);
  const { sqlite, db } = reviewWorld();
  const saved = await setup.draftProviderCommercialTerms(db, { providerId: "PRV-FT-FUN", engagement: "full_time", services: [{ serviceCode: "funeral" }, { serviceCode: "grooming" }], reason: "Joined as a full-time contractor", actorId: MAKER });
  assert.deepEqual(saved.drafts.map((d) => [d.serviceCode, d.preview.gst]), [["funeral", 0], ["grooming", 180]]);
  await setup.activateProviderCommercialTerms(db, { providerId: "PRV-FT-FUN", approvalReference: "FIN-APR-FT", actorId: CHECKER });
  booking(sqlite, { id: "BK-FUN", providerId: "PRV-FT-FUN", service: "funeral", day: "2026-10-10" });
  const engine = await terms.computeOrderPayout(db, { bookingId: "BK-FUN", actorId: CHECKER, persist: false });
  assert.deepEqual([engine.supplyModel, engine.pawspaceGstOnOrder, engine.providerNetPayout], ["own_supply", 0, 0], "the engine agrees with the preview");
});

test("a commission provider who also offers funeral is shown and recorded as a commission provider", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { db } = reviewWorld();
  await setup.draftProviderCommercialTerms(db, { providerId: "PRV-MIX", engagement: "commission", services: [{ serviceCode: "funeral", pawspaceCommissionPercent: 45 }, { serviceCode: "grooming" }], reason: "Agreed at onboarding interview", actorId: MAKER });
  const view = await setup.providerCommercialTermsView(db, { providerId: "PRV-MIX" });
  assert.equal(view.engagement, "commission", "the screen must not reopen as a funeral vendor, which would refuse the grooming row");
  const activated = await setup.activateProviderCommercialTerms(db, { providerId: "PRV-MIX", approvalReference: "FIN-APR-MIX", actorId: CHECKER });
  assert.equal(activated.engagement, "commission");
  assert.deepEqual(activated.activated.map((t) => [t.serviceCode, t.engagementModel]), [["funeral", "funeral_exempt"], ["grooming", "commission_groomer"]]);
});

test("an approved override keeps the older approval steps in step with the engine", async () => {
  const commission = await import("../lib/provider-commission-governance.ts");
  const { sqlite, db } = reviewWorld();
  sqlite.exec(`CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);`);
  await activeTerm(db, { serviceCode: "grooming", model: "commission_groomer", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-GRM" });
  for (const id of ["BK-OWN", "BK-DONE"]) {
    booking(sqlite, { id, providerId: "PRV-OLDSTEP", service: "grooming", day: "2026-09-20", status: "completed" });
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,'PRV-OLDSTEP','commission','grooming','completed',?,?)").run(`WO-${id}`, id, NOW, NOW);
    sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,actor_id,occurred_at) VALUES (?,?,'booking_completed','provider',?)").run(`EV-${id}`, id, NOW - DAY);
  }
  await commission.syncCompletedCommissionOrders(db);
  const older = (id) => { const r = sqlite.prepare("SELECT commission_amount,status FROM provider_order_commissions WHERE booking_id=?").get(id); return [r.commission_amount, r.status]; };
  assert.deepEqual(older("BK-OWN"), [700, "pending_confirmation"]);
  // Own supply (a company vehicle and staff) approved by a second person: the older steps must not still pay Rs 700.
  await terms.setOrderCommercialOverride(db, { bookingId: "BK-OWN", engagementModel: "direct_employee", reason: "Company vehicle and staff did this job", actorId: MAKER });
  const approved = await commission.approveOrderCommissionOverride(db, { bookingId: "BK-OWN", actor: CHECKER });
  assert.deepEqual(approved.olderApprovalSteps, { commissionValue: null, commissionAmount: 0 });
  assert.deepEqual(older("BK-OWN"), [0, "configuration_required"]);
  await assert.rejects(() => commission.confirmOrderCommission(db, { bookingId: "BK-OWN", actor: OTHER }), /Configured pending commission is required/);
  assert.equal((await terms.computeOrderPayout(db, { bookingId: "BK-OWN", actorId: CHECKER, persist: false })).providerNetPayout, 0, "the engine agrees");
  // A booking already confirmed in the older steps: an override would change the split but not the payment, so it is refused.
  await commission.confirmOrderCommission(db, { bookingId: "BK-DONE", actor: OTHER });
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-DONE", providerSharePct: 0.8, reason: "Late special rate", actorId: MAKER }), (error) => error.status === 409 && /already confirmed in the older approval steps/.test(error.message));
  assert.deepEqual(older("BK-DONE"), [700, "awaiting_approval_1"]);
});

test("a rejection that loses the race with an approval is refused and not audited as a rejection", async () => {
  const { sqlite, db } = reviewWorld();
  await activeTerm(db, { serviceCode: "grooming", model: "commission_groomer", share: 0.7, effectiveFrom: "2026-01-01", reference: "FIN-APR-GRM" });
  booking(sqlite, { id: "BK-RACE", providerId: "PRV-RACE", service: "grooming", day: "2026-10-10" });
  const request = await terms.setOrderCommercialOverride(db, { bookingId: "BK-RACE", providerSharePct: 0.8, reason: "Special rate for this order", actorId: MAKER });
  // The rejecter loaded the request while it was still waiting; a second person approved it before the rejection landed.
  const stale = sqlite.prepare("SELECT * FROM order_commercial_override_requests WHERE id=?").get(request.requestId);
  await terms.approveOrderCommercialOverride(db, { requestId: request.requestId, actorId: CHECKER });
  const hadOwn = Object.prototype.hasOwnProperty.call(db, "prepare"), original = db.prepare;
  let served = false;
  db.prepare = function (sql) { if (!served && sql === "SELECT * FROM order_commercial_override_requests WHERE id=?") { served = true; return { bind: () => ({ first: async () => ({ ...stale }) }) }; } return original.call(this, sql); };
  try {
    await assert.rejects(() => terms.rejectOrderCommercialOverride(db, { requestId: request.requestId, actorId: OTHER }), (error) => error.status === 409 && /approved or rejected by someone else first/.test(error.message));
  } finally { if (hadOwn) db.prepare = original; else delete db.prepare; }
  assert.equal(served, true, "the rejection read the stale waiting request");
  assert.equal(sqlite.prepare("SELECT status FROM order_commercial_override_requests WHERE id=?").get(request.requestId).status, "approved");
  assert.deepEqual(sqlite.prepare("SELECT action FROM commercial_terms_audit WHERE term_id=? ORDER BY created_at").all(request.requestId).map((r) => r.action), ["order_override_requested", "order_override_approved"]);
  assert.deepEqual(await payoutOf(db, "BK-RACE"), [800, 200, 36, "service_default"]);
});
