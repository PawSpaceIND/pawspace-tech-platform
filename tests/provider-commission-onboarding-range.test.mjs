/*
 * Owner decision 8 (26 Sept 2026) and audit gaps G13/G14: ONE commission system.
 *
 *  - PawSpace's commission is 10-40% of the amount paid, 30% by default, for service defaults, provider terms and
 *    per-order overrides. A per-order override also needs a reason and a second person to approve it.
 *  - Staff set a provider's engagement and commission per service at onboarding and on Finance > Partners. That
 *    drafts provider_commercial_terms (the maker); a different person activates them with an approval reference.
 *  - The older provider_compensation_profiles "commission %" (the PROVIDER's share: 70 = provider 70%, PawSpace
 *    30%) is carried over once into provider_commercial_terms, audited, and nothing pays from it any more.
 *
 * Everything here EXECUTES the real modules and routes on an in-memory SQLite database. Modules added by this
 * change are imported inside the tests that need them, so on the code before it each test fails on its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__COMMISSION_RANGE_DB__", "__COMMISSION_RANGE_ENV__");
process.env.FORBID_PRODUCTION = "true";
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const terms = await import("../lib/provider-commercial-terms.ts");
const commission = await import("../lib/provider-commission-governance.ts");
const training = await import("../lib/training-commission-payout.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");

const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const MAKER = "finance.maker@pawspace.test", CHECKER = "finance.checker@pawspace.test", FOUNDER = "founder.ops@pawspace.test";
const NOW = Date.now();

function rangeWorld() {
  const { sqlite, db } = world("__COMMISSION_RANGE_DB__", "__COMMISSION_RANGE_ENV__", SANDBOX);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT,detail_json TEXT DEFAULT '{}',occurred_at INTEGER NOT NULL);
  `);
  return { sqlite, db };
}
function booking(sqlite, { id, providerId, service = "grooming", total = 1000, status = "completed", day = "2026-09-20" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,scheduled_start,created_at,updated_at) VALUES (?,?,'blr',?,?,?,?,'INR',?,?,?)").run(id, `CUS-${id}`, service, providerId, status, total, `${day}T05:00:00.000Z`, NOW, NOW);
}
function completedCommissionJob(sqlite, { id, providerId, service = "grooming", total = 1000 }) {
  booking(sqlite, { id, providerId, service, total });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,'commission',?,'completed',?,?)").run(`WO-${id}`, id, providerId, service, NOW, NOW);
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,actor_id,occurred_at) VALUES (?,?,'booking_completed','provider',?)").run(`EV-${id}`, id, NOW - 86_400_000);
}
async function capacityProvider(sqlite, db, id, services, model = "commission") {
  await capacity.ensureProviderCapacityTables(db);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'blr',?,?,?,'[\"blr-east\"]',1,4.8,95,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").run(id, `Provider ${id}`, model, JSON.stringify(services), NOW);
}
async function activeDefault(db, serviceCode, share = 0.70, model = "commission_standard") {
  const draft = await terms.saveCommercialTerm(db, { serviceCode, engagementModel: model, providerSharePct: share, effectiveFrom: "2026-01-01", reason: `${serviceCode} service default`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `TEST-${serviceCode}`, actorId: CHECKER });
  return draft.id;
}
const termRows = (sqlite, providerId) => sqlite.prepare("SELECT service_code,status,engagement_model,provider_share_pct,created_by,approved_by,approval_reference FROM provider_commercial_terms WHERE provider_id=? ORDER BY service_code,version").all(providerId);

test("PawSpace's commission outside 10-40% is refused for service defaults, and the edges are allowed", async () => {
  const { db } = rangeWorld();
  const save = (share, serviceCode = "boarding", engagementModel = "commission_standard") => terms.saveCommercialTerm(db, { serviceCode, engagementModel, providerSharePct: share, effectiveFrom: "2026-01-01", reason: "Boarding service default", actorId: MAKER });
  await assert.rejects(() => save(0.91), /PawSpace's commission for boarding cannot be below 10% of the amount paid \(you entered 9%\)/);
  await assert.rejects(() => save(0.59), /PawSpace's commission for boarding cannot be above 40% of the amount paid \(you entered 41%\)/);
  await assert.rejects(() => save(0.91, "grooming", "commission_groomer"), /cannot be below 10%/);
  assert.equal((await save(0.90)).providerSharePct, 0.90, "PawSpace 10% is allowed");
  assert.equal((await save(0.60)).providerSharePct, 0.60, "PawSpace 40% is allowed");
  // Funeral is not a commission service (decisions 2 and 4): its share is not held to the commission range.
  assert.equal((await save(0.55, "funeral", "funeral_exempt")).providerSharePct, 0.55);
  // With no share given, the commission default is 30% (provider 70%).
  assert.equal((await terms.saveCommercialTerm(db, { serviceCode: "dog_walking", engagementModel: "commission_standard", effectiveFrom: "2026-01-01", reason: "Walking service default", actorId: MAKER })).providerSharePct, 0.70);
});

test("a draft saved outside the range before it existed cannot be activated", async () => {
  const { sqlite, db } = rangeWorld();
  await terms.ensureCommercialTermsTables(db);
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,effective_from,reason,created_by,created_at,updated_at) VALUES ('PCT-OLD','boarding','PRV-OLD',1,'draft','commission_standard',0.95,'none',0.18,0,'2026-01-01','old draft at 5%',?,?,?)").run(MAKER, NOW, NOW);
  await assert.rejects(() => terms.activateCommercialTerm(db, { termId: "PCT-OLD", approvalReference: "FIN-APR-1", actorId: CHECKER }), /cannot be below 10%.*cannot be activated/);
  assert.equal(sqlite.prepare("SELECT status FROM provider_commercial_terms WHERE id='PCT-OLD'").get().status, "draft");
});

test("provider terms default to 30%, refuse 9% and 41%, and show the plain-English preview", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = rangeWorld();
  const draft = (services, engagement = "commission") => setup.draftProviderCommercialTerms(db, { providerId: "PRV-NEW", engagement, services, reason: "Agreed at onboarding interview", actorId: MAKER });
  await assert.rejects(() => draft([{ serviceCode: "grooming", pawspaceCommissionPercent: 9 }]), /PawSpace's commission for grooming cannot be below 10% of the amount paid \(you entered 9%\)/);
  await assert.rejects(() => draft([{ serviceCode: "boarding", pawspaceCommissionPercent: 41 }]), /PawSpace's commission for boarding cannot be above 40% of the amount paid \(you entered 41%\)/);
  await assert.rejects(() => draft([{ serviceCode: "boarding", pawspaceCommissionPercent: 30 }], "funeral_vendor"), /A funeral \/ memorial vendor can only be set for funeral or memorial services, not boarding/);
  assert.equal(termRows(sqlite, "PRV-NEW").length, 0, "a refused proposal saves nothing");
  const saved = await draft([{ serviceCode: "grooming" }, { serviceCode: "boarding", pawspaceCommissionPercent: 20 }]);
  assert.equal(saved.status, "awaiting_approval");
  const rows = termRows(sqlite, "PRV-NEW");
  assert.deepEqual(rows.map(r => [r.service_code, r.status, r.engagement_model, r.provider_share_pct]), [["boarding", "draft", "commission_standard", 0.8], ["grooming", "draft", "commission_groomer", 0.7]]);
  const grooming = saved.drafts.find(d => d.serviceCode === "grooming");
  assert.equal(grooming.pawspaceCommissionPercent, 30, "no number given means 30%");
  assert.deepEqual([grooming.preview.providerGets, grooming.preview.pawspaceKeeps, grooming.preview.gst, grooming.preview.pawspaceAfterGst], [700, 300, 54, 246]);
  assert.equal(grooming.preview.sentence, "On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays Rs 54 GST");
  assert.equal(saved.drafts.find(d => d.serviceCode === "boarding").preview.sentence, "On a Rs 1,000 booking: provider gets Rs 800, PawSpace keeps Rs 200 and pays Rs 36 GST");
});

test("the preview follows the one GST setting and the engagement", async () => {
  const range = await import("../lib/commission-range.ts");
  const preview = (engagement, percent, gstPolicy) => range.commissionPreview({ engagement, pawspaceCommissionPercent: percent, gstPolicy }).sentence;
  assert.equal(preview("commission", 30), "On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays Rs 54 GST");
  assert.equal(preview("commission", 30, { ratePercent: 18, method: "extract_inclusive" }), "On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays Rs 45.76 GST");
  assert.equal(preview("funeral_vendor", 30), "On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays no GST (funeral and memorial are GST exempt)");
  assert.match(preview("full_time"), /^On a Rs 1,000 booking: PawSpace keeps Rs 1,000 and pays Rs 180 GST\. The provider is paid a monthly fee through Contractor pay/);
  // The server's preview reads the setting Finance published.
  const setup = await import("../lib/provider-commission-setup.ts");
  const gst = await import("../lib/gst-setting.ts");
  const { db } = rangeWorld();
  await gst.saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-01-01", reason: "CA confirmed prices include GST", actorId: MAKER });
  const saved = await setup.draftProviderCommercialTerms(db, { providerId: "PRV-GST", engagement: "commission", services: [{ serviceCode: "grooming" }], reason: "Agreed at onboarding interview", actorId: MAKER });
  assert.equal(saved.drafts[0].preview.sentence, "On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays Rs 45.76 GST");
});

test("the maker cannot activate their own terms; a second person activates them with a reference", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = rangeWorld();
  await capacityProvider(sqlite, db, "PRV-MC", ["grooming"]);
  await setup.draftProviderCommercialTerms(db, { providerId: "PRV-MC", engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 30 }], effectiveFrom: "2026-01-01", reason: "Agreed at onboarding interview", actorId: MAKER });
  await assert.rejects(() => setup.activateProviderCommercialTerms(db, { providerId: "PRV-MC", approvalReference: "FIN-APR-7", actorId: MAKER }), (error) => error.status === 409 && /the drafter cannot activate their own commercial term/.test(error.message));
  await assert.rejects(() => setup.activateProviderCommercialTerms(db, { providerId: "PRV-MC", approvalReference: "", actorId: CHECKER }), /approval reference is required/);
  const activated = await setup.activateProviderCommercialTerms(db, { providerId: "PRV-MC", approvalReference: "FIN-APR-7", actorId: CHECKER });
  assert.equal(activated.status, "active");
  assert.deepEqual(termRows(sqlite, "PRV-MC").map(r => [r.service_code, r.status, r.created_by, r.approved_by, r.approval_reference]), [["grooming", "active", MAKER, CHECKER, "FIN-APR-7"]]);
  // The engine pays from it: Rs 1,000 -> provider 700, commission 300, GST 54.
  booking(sqlite, { id: "BK-MC", providerId: "PRV-MC" });
  const payout = await terms.computeOrderPayout(db, { bookingId: "BK-MC", actorId: CHECKER, persist: false });
  assert.deepEqual([payout.termSource, payout.providerNetPayout, payout.platformFee, payout.platformGst], ["provider", 700, 300, 54]);
});

test("a provider's terms are activated all or nothing", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = rangeWorld();
  await setup.draftProviderCommercialTerms(db, { providerId: "PRV-SET", engagement: "commission", services: [{ serviceCode: "grooming" }], reason: "Agreed at onboarding interview", actorId: MAKER });
  // A draft saved before the range existed, for the same provider.
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,effective_from,reason,created_by,created_at,updated_at) VALUES ('PCT-SET-OLD','boarding','PRV-SET',1,'draft','commission_standard',0.5,'none',0.18,0,'2026-01-01','old draft at 50%',?,?,?)").run(MAKER, NOW, NOW);
  await assert.rejects(() => setup.activateProviderCommercialTerms(db, { providerId: "PRV-SET", approvalReference: "FIN-APR-SET", actorId: CHECKER }), /cannot be above 40%.*cannot be activated/);
  assert.deepEqual(termRows(sqlite, "PRV-SET").map(r => r.status), ["draft", "draft"], "nothing went live");
});

test("the per-term maker/checker cannot be dodged by changing the case of an email", async () => {
  const { db } = rangeWorld();
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "boarding", engagementModel: "commission_standard", providerSharePct: 0.7, effectiveFrom: "2026-01-01", reason: "Boarding service default", actorId: MAKER });
  await assert.rejects(() => terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "FIN-APR-9", actorId: MAKER.toUpperCase() }), /the drafter cannot activate their own commercial term/);
});

test("activating full-time contractor terms records the engagement everywhere and gives no share", async () => {
  const setup = await import("../lib/provider-commission-setup.ts");
  const { sqlite, db } = rangeWorld();
  await capacityProvider(sqlite, db, "PRV-FT", ["grooming"]);
  const saved = await setup.draftProviderCommercialTerms(db, { providerId: "PRV-FT", engagement: "full_time", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 99 }], reason: "Joined as a full-time groomer", actorId: MAKER });
  assert.equal(saved.drafts[0].engagementModel, "direct_employee");
  assert.match(saved.drafts[0].preview.sentence, /PawSpace keeps Rs 1,000 and pays Rs 180 GST/);
  await setup.activateProviderCommercialTerms(db, { providerId: "PRV-FT", approvalReference: "FIN-APR-FT", actorId: CHECKER });
  assert.equal(sqlite.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id='PRV-FT'").get().provider_model, "full_time");
  assert.equal(sqlite.prepare("SELECT engagement_model FROM provider_compensation_profiles WHERE provider_id='PRV-FT'").get().engagement_model, "full_time");
  assert.equal(termRows(sqlite, "PRV-FT")[0].provider_share_pct, 0);
});

test("a legacy commission of 70 (the provider's share) is carried over once as PawSpace 30%, audited", async () => {
  const { sqlite, db } = rangeWorld();
  await capacityProvider(sqlite, db, "PRV-LEG", ["grooming", "boarding"]);
  await commission.ensureProviderCommissionTables(db);
  const legacy = (id, mode, value) => sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission',?,?,'active','older profile','finance.old@pawspace.test',?,?)").run(id, mode, value, Date.parse("2026-03-01T00:00:00Z"), NOW);
  legacy("PRV-LEG", "percent", 70);
  legacy("PRV-HALF", "percent", 50);
  await capacityProvider(sqlite, db, "PRV-HALF", ["grooming"]);
  const result = await commission.migrateLegacyCommissionProfiles(db);
  assert.deepEqual(result, { migrated: 1, notMigrated: 1 });
  const carried = termRows(sqlite, "PRV-LEG");
  assert.deepEqual(carried.map(r => [r.service_code, r.status, r.engagement_model, r.provider_share_pct, r.approval_reference]), [["boarding", "active", "commission_standard", 0.7, "LEGACY-PROFILE-PRV-LEG"], ["grooming", "active", "commission_groomer", 0.7, "LEGACY-PROFILE-PRV-LEG"]]);
  const audit = sqlite.prepare("SELECT action,detail_json FROM commercial_terms_audit WHERE term_id='LEGACY-PROFILE-PRV-LEG'").get();
  assert.equal(audit.action, "legacy_commission_migrated");
  const detail = JSON.parse(audit.detail_json);
  assert.deepEqual([detail.legacyCommissionPercent, detail.legacyMeaning, detail.pawspaceCommissionPercent], [70, "provider share", 30]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM commercial_terms_audit WHERE action='migrated_from_legacy_profile'").get().n, 2);
  // 50 would make PawSpace's commission 50%: not carried over, audited, and listed for Finance.
  assert.equal(termRows(sqlite, "PRV-HALF").length, 0);
  assert.equal(sqlite.prepare("SELECT action FROM commercial_terms_audit WHERE term_id='LEGACY-PROFILE-PRV-HALF'").get().action, "legacy_commission_not_migrated");
  const needing = await commission.legacyCommissionNeedingDecision(db);
  assert.deepEqual(needing.map(n => [n.providerId, n.pawspaceCommissionPercent]), [["PRV-HALF", 50]]);
  assert.match(needing[0].reason, /would make PawSpace's commission 50%, outside 10% to 40%/);
  // Once: a second run changes nothing.
  assert.deepEqual(await commission.migrateLegacyCommissionProfiles(db), { migrated: 0, notMigrated: 0 });
  assert.equal(termRows(sqlite, "PRV-LEG").length, 2);
});

test("nothing pays from the legacy percentage any more: the older approval steps and training read the terms", async () => {
  const { sqlite, db } = rangeWorld();
  await capacityProvider(sqlite, db, "PRV-PAY", ["grooming"]);
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,status,reason,updated_by,created_at,updated_at) VALUES ('PRV-PAY','commission','percent',70,'active','older profile','finance.old@pawspace.test',?,?)").run(NOW, NOW);
  completedCommissionJob(sqlite, { id: "BK-PAY-1", providerId: "PRV-PAY" });
  await commission.syncCompletedCommissionOrders(db);
  const first = sqlite.prepare("SELECT commission_amount,commission_value,commission_source,status FROM provider_order_commissions WHERE booking_id='BK-PAY-1'").get();
  assert.deepEqual([first.commission_amount, first.commission_value, first.commission_source, first.status], [700, 70, "commercial_term", "pending_confirmation"]);
  // Someone edits the retired column directly: it must not change what is paid.
  sqlite.prepare("UPDATE provider_compensation_profiles SET default_commission_value=99 WHERE provider_id='PRV-PAY'").run();
  completedCommissionJob(sqlite, { id: "BK-PAY-2", providerId: "PRV-PAY" });
  await commission.syncCompletedCommissionOrders(db);
  assert.equal(sqlite.prepare("SELECT commission_amount FROM provider_order_commissions WHERE booking_id='BK-PAY-2'").get().commission_amount, 700);
  // A provider with only an old percentage for a service it was never carried over for is not paid from it.
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,status,reason,updated_by,created_at,updated_at) VALUES ('PRV-NOTERM','commission','fixed',400,'active','older fixed amount','finance.old@pawspace.test',?,?)").run(NOW, NOW);
  completedCommissionJob(sqlite, { id: "BK-NOTERM", providerId: "PRV-NOTERM" });
  await commission.syncCompletedCommissionOrders(db);
  const unpaid = sqlite.prepare("SELECT commission_amount,status FROM provider_order_commissions WHERE booking_id='BK-NOTERM'").get();
  assert.deepEqual([unpaid.commission_amount, unpaid.status], [0, "configuration_required"]);
  // The older profile no longer takes a commission percentage at all.
  await assert.rejects(() => commission.saveProviderCompensationProfile(db, { providerId: "PRV-PAY", engagementModel: "commission", commissionMode: "percent", commissionValue: 30, reason: "Trying the old screen", actor: MAKER }), /commercial terms/);
  // Training milestones: the trainer's share is the commercial term's, not the profile's.
  await training.ensureTrainingCommissionPayoutTables(db);
  sqlite.exec("CREATE TABLE training_programmes (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,total_sessions INTEGER); CREATE TABLE training_sessions (id TEXT PRIMARY KEY,programme_id TEXT,booking_id TEXT,sequence_no INTEGER,status TEXT,completed_at INTEGER,updated_at INTEGER);");
  booking(sqlite, { id: "BK-TRN", providerId: "PRV-PAY", service: "dog_training", total: 10000, status: "in_progress" });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,service_code,status) VALUES ('WO-TRN','BK-TRN','PRV-PAY','commission','dog_training','assigned')").run();
  sqlite.prepare("INSERT INTO training_programmes VALUES ('PG-TRN','BK-TRN','PRV-PAY',2)").run();
  sqlite.prepare("INSERT INTO training_sessions VALUES ('S1','PG-TRN','BK-TRN',1,'completed',?,?)").run(NOW, NOW);
  const skipped = await training.syncTrainingCommissionPayoutMilestones(db, NOW);
  assert.deepEqual(skipped, { synced: 0, skippedConfiguration: 1 }, "no training term: the 99 in the old profile is not used");
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "dog_training", providerId: "PRV-PAY", engagementModel: "commission_standard", providerSharePct: 0.75, effectiveFrom: "2026-01-01", reason: "Trainer commercial terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "FIN-APR-TRN", actorId: CHECKER });
  await training.syncTrainingCommissionPayoutMilestones(db, NOW);
  const milestone = sqlite.prepare("SELECT commission_value,package_commission_amount,payout_amount FROM training_commission_payout_milestones WHERE booking_id='BK-TRN'").get();
  assert.deepEqual([milestone.commission_value, milestone.package_commission_amount, milestone.payout_amount], [75, 7500, 3750]);
});

test("a per-order override needs a reason, stays inside 10-40%, and a second person must approve it", async () => {
  const { sqlite, db } = rangeWorld();
  await activeDefault(db, "grooming", 0.70, "commission_groomer");
  booking(sqlite, { id: "BK-OV", providerId: "PRV-OV", status: "confirmed" });
  const split = async () => { const p = await terms.computeOrderPayout(db, { bookingId: "BK-OV", actorId: CHECKER, persist: false }); return [p.providerNetPayout, p.platformFee, p.platformGst]; };
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-OV", providerSharePct: 0.5, reason: "Founder asked for a special rate", actorId: MAKER }), /PawSpace's commission for booking BK-OV cannot be above 40%/);
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-OV", providerSharePct: 0.95, reason: "Founder asked for a special rate", actorId: MAKER }), /cannot be below 10%/);
  await assert.rejects(() => terms.setOrderCommercialOverride(db, { bookingId: "BK-OV", providerSharePct: 0.8, reason: "short", actorId: MAKER }), /clear reason is required/);
  const request = await terms.setOrderCommercialOverride(db, { bookingId: "BK-OV", providerSharePct: 0.8, reason: "Founder asked for a special rate", actorId: MAKER });
  assert.equal(request.status, "awaiting_approval");
  assert.deepEqual(await split(), [700, 300, 54], "a request alone changes nothing");
  await assert.rejects(() => terms.approveOrderCommercialOverride(db, { bookingId: "BK-OV", actorId: MAKER }), (error) => error.status === 409 && /A second person must approve an order override/.test(error.message));
  await assert.rejects(() => terms.approveOrderCommercialOverride(db, { bookingId: "BK-OV", actorId: ` ${MAKER.toUpperCase()} ` }), /second person/);
  assert.deepEqual(await split(), [700, 300, 54]);
  const approved = await terms.approveOrderCommercialOverride(db, { bookingId: "BK-OV", actorId: CHECKER });
  assert.deepEqual([approved.status, approved.requestedBy, approved.approvedBy, approved.pawspaceCommissionPercent], ["approved", MAKER, CHECKER, 20]);
  assert.deepEqual(await split(), [800, 200, 36], "Rs 1,000 at PawSpace 20%: provider 800, commission 200, GST 36");
  const row = sqlite.prepare("SELECT actor_id,approved_by,request_id FROM order_commercial_overrides WHERE booking_id='BK-OV'").get();
  assert.deepEqual([row.actor_id, row.approved_by, row.request_id], [MAKER, CHECKER, request.requestId]);
  await assert.rejects(() => terms.approveOrderCommercialOverride(db, { bookingId: "BK-OV", actorId: CHECKER }), /No order override is waiting/);
  assert.deepEqual(sqlite.prepare("SELECT action FROM commercial_terms_audit WHERE term_id=? ORDER BY created_at").all(request.requestId).map(r => r.action), ["order_override_requested", "order_override_approved"]);
});

test("an override on a booking in the older approval steps is a request until a second person approves it", async () => {
  const { sqlite, db } = rangeWorld();
  await activeDefault(db, "grooming", 0.70, "commission_groomer");
  completedCommissionJob(sqlite, { id: "BK-OLD", providerId: "PRV-OLD" });
  await commission.syncCompletedCommissionOrders(db);
  await assert.rejects(() => commission.requestOrderCommissionOverride(db, { bookingId: "BK-OLD", pawspaceCommissionPercent: 45, reason: "Special rate for this order", actor: MAKER }), /cannot be above 40%/);
  await commission.requestOrderCommissionOverride(db, { bookingId: "BK-OLD", pawspaceCommissionPercent: 25, reason: "Special rate for this order", actor: MAKER });
  assert.equal(sqlite.prepare("SELECT commission_amount FROM provider_order_commissions WHERE booking_id='BK-OLD'").get().commission_amount, 700, "unchanged until approved");
  await assert.rejects(() => commission.approveOrderCommissionOverride(db, { bookingId: "BK-OLD", actor: MAKER }), /second person/);
  const approved = await commission.approveOrderCommissionOverride(db, { bookingId: "BK-OLD", actor: CHECKER });
  assert.deepEqual(approved.olderApprovalSteps, { commissionValue: 75, commissionAmount: 750 });
  const row = sqlite.prepare("SELECT commission_amount,commission_source,status FROM provider_order_commissions WHERE booking_id='BK-OLD'").get();
  assert.deepEqual([row.commission_amount, row.commission_source, row.status], [750, "order_override", "pending_confirmation"]);
});

test("the Finance partners screen renders the commission terms and posts them to the new API", async () => {
  const { sqlite, db } = rangeWorld();
  const { default: PartnerFinancePage } = await import("../app/team/finance/partners/page.tsx");
  const html = renderToStaticMarkup(React.createElement(PartnerFinancePage));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
  assert.match(text, /Provider commercial terms/);
  assert.match(text, /PawSpace's commission is 10% to 40% of the amount the customer paid, 30% unless you change it/);
  assert.match(text, /On a Rs 1,000 booking: provider gets Rs 700, PawSpace keeps Rs 300 and pays Rs 54 GST/);
  assert.match(text, /Save for approval/);
  assert.match(text, /Approve and activate/);
  assert.match(text, /Order overrides waiting for a second person/);
  assert.doesNotMatch(html, /placeholder="Commission %"|Fixed amount/, "the older provider-share % form is gone");

  const panel = await import("../app/team/finance/partners/commercial-terms-panel.tsx");
  await seedActors(sqlite, db, [{ id: "USR-FIN-M", email: MAKER, role: "finance" }, { id: "USR-FIN-C", email: CHECKER, role: "finance" }, { id: "USR-FOUNDER", email: FOUNDER, role: "superuser" }]);
  const partnerFinance = await import("../app/api/partner-finance/route.ts");
  const termsApi = await import("../app/api/provider-commercial-terms/route.ts");
  const onboardingApi = await import("../app/api/provider-onboarding/route.ts");
  const posted = [];
  const fetchAs = (email) => async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    const request = asActor(email, url, { method: "POST", body: init.body });
    if (url === "/api/partner-finance") return partnerFinance.POST(request);
    if (url === "/api/provider-commercial-terms") return termsApi.POST(request);
    if (url === "/api/provider-onboarding") return onboardingApi.POST(request);
    return new Response("not found", { status: 404 });
  };
  const proposal = { providerId: "PRV-UI", engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: "30" }, { serviceCode: "boarding", pawspaceCommissionPercent: "" }], effectiveFrom: "2026-10-01", reason: "Agreed at onboarding interview" };
  const tooHigh = await panel.sendTermsRequest(fetchAs(MAKER), panel.providerTermsSaveRequest("finance", { ...proposal, services: [{ serviceCode: "grooming", pawspaceCommissionPercent: "41" }] }));
  assert.deepEqual(tooHigh, { ok: false, error: "PawSpace's commission for grooming cannot be above 40% of the amount paid (you entered 41%)." });
  const saved = await panel.sendTermsRequest(fetchAs(MAKER), panel.providerTermsSaveRequest("finance", proposal));
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(posted.at(-1), { url: "/api/partner-finance", body: { action: "save_provider_commercial_terms", providerId: "PRV-UI", engagement: "commission", services: [{ serviceCode: "grooming", pawspaceCommissionPercent: 30 }, { serviceCode: "boarding", pawspaceCommissionPercent: null }], effectiveFrom: "2026-10-01", reason: "Agreed at onboarding interview" } });
  assert.deepEqual(termRows(sqlite, "PRV-UI").map(r => [r.service_code, r.status, r.provider_share_pct, r.created_by]), [["boarding", "draft", 0.7, MAKER], ["grooming", "draft", 0.7, MAKER]]);
  const own = await panel.sendTermsRequest(fetchAs(MAKER), panel.providerTermsActivateRequest("finance", "PRV-UI", "FIN-APR-22"));
  assert.equal(own.ok, false);
  assert.match(own.error, /the drafter cannot activate their own commercial term/);
  const checked = await panel.sendTermsRequest(fetchAs(CHECKER), panel.providerTermsActivateRequest("finance", "PRV-UI", "FIN-APR-22"));
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(termRows(sqlite, "PRV-UI").map(r => [r.service_code, r.status, r.approved_by, r.approval_reference]), [["boarding", "active", CHECKER, "FIN-APR-22"], ["grooming", "active", CHECKER, "FIN-APR-22"]]);
  const audits = sqlite.prepare("SELECT action,actor_email FROM security_audit_events WHERE action LIKE 'partner.commercial_terms.%' ORDER BY created_at").all();
  assert.deepEqual(audits.map(a => [a.action, a.actor_email]), [["partner.commercial_terms.propose", MAKER], ["partner.commercial_terms.activate", CHECKER]]);

  // At onboarding the same panel proposes through the onboarding API, for the application's provider.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,status,created_at,updated_at) VALUES ('APP-UI','PRV-ONB','activated_uat',?,?)").run(NOW, NOW);
  const onboarding = await panel.sendTermsRequest(fetchAs(FOUNDER), panel.providerTermsSaveRequest("onboarding", { ...proposal, providerId: "PRV-ONB", applicationId: "APP-UI", engagement: "funeral_vendor", services: [{ serviceCode: "funeral_memorial", pawspaceCommissionPercent: "35" }] }));
  assert.equal(onboarding.ok, true, onboarding.error);
  assert.equal(posted.at(-1).url, "/api/provider-onboarding");
  assert.deepEqual(termRows(sqlite, "PRV-ONB").map(r => [r.service_code, r.status, r.engagement_model, r.provider_share_pct]), [["funeral_memorial", "draft", "funeral_exempt", 0.65]]);
  const view = await termsApi.GET(asActor(CHECKER, "/api/provider-commercial-terms?providerId=PRV-ONB"));
  assert.equal(view.status, 200);
  const body = (await view.json()).data;
  assert.deepEqual([body.engagement, body.awaitingApproval.length, body.proposedBy], ["funeral_vendor", 1, [FOUNDER]]);
});

test("the Finance route refuses an out-of-range order override in plain words and lists requests for approval", async () => {
  const { sqlite, db } = rangeWorld();
  await seedActors(sqlite, db, [{ id: "USR-FIN-M", email: MAKER, role: "finance" }, { id: "USR-FIN-C", email: CHECKER, role: "finance" }]);
  await activeDefault(db, "grooming", 0.70, "commission_groomer");
  completedCommissionJob(sqlite, { id: "BK-ROUTE", providerId: "PRV-ROUTE" });
  await commission.syncCompletedCommissionOrders(db);
  const route = await import("../app/api/partner-finance/route.ts");
  const post = (email, body) => route.POST(asActor(email, "/api/partner-finance", { method: "POST", body: JSON.stringify(body) }));
  const refused = await post(MAKER, { action: "override_order_commission", bookingId: "BK-ROUTE", pawspaceCommissionPercent: 9, reason: "Special rate for this order" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "PawSpace's commission for booking BK-ROUTE cannot be below 10% of the amount paid (you entered 9%).");
  const asked = await post(MAKER, { action: "override_order_commission", bookingId: "BK-ROUTE", pawspaceCommissionPercent: 20, reason: "Special rate for this order" });
  assert.equal(asked.status, 201, await asked.clone().text());
  const same = await post(MAKER, { action: "approve_order_override", bookingId: "BK-ROUTE" });
  assert.equal(same.status, 409);
  assert.match((await same.json()).error, /A second person must approve an order override/);
  const other = await post(CHECKER, { action: "approve_order_override", bookingId: "BK-ROUTE" });
  assert.equal(other.status, 200, await other.clone().text());
  assert.equal(sqlite.prepare("SELECT commission_amount FROM provider_order_commissions WHERE booking_id='BK-ROUTE'").get().commission_amount, 800);
  // Any booking not yet completed: the same range and second approver, through the Finance route.
  booking(sqlite, { id: "BK-ANY", providerId: "PRV-ANY", status: "confirmed" });
  const outside = await post(MAKER, { action: "request_order_override", bookingId: "BK-ANY", pawspaceCommissionPercent: 41, reason: "Special rate for this order" });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).error, "PawSpace's commission for booking BK-ANY cannot be above 40% of the amount paid (you entered 41%).");
  const request = await post(MAKER, { action: "request_order_override", bookingId: "BK-ANY", pawspaceCommissionPercent: 15, reason: "Special rate for this order" });
  assert.equal(request.status, 201, await request.clone().text());
  const listed = await route.GET(asActor(CHECKER, "/api/partner-finance"));
  assert.equal(listed.status, 200, await listed.clone().text());
  const waiting = (await listed.json()).data.commercialTerms.overrideRequests;
  assert.deepEqual(waiting.map(r => [r.booking_id, r.requested_by, r.pawspace_commission_percent]), [["BK-ANY", MAKER, 15]]);
  assert.equal((await post(MAKER, { action: "approve_order_override", requestId: waiting[0].id })).status, 409);
  assert.equal((await post(CHECKER, { action: "approve_order_override", requestId: waiting[0].id })).status, 200);
  assert.equal((await terms.computeOrderPayout(db, { bookingId: "BK-ANY", actorId: CHECKER, persist: false })).providerNetPayout, 850);
  const legacyForm = await post(MAKER, { action: "save_provider_profile", providerId: "PRV-ROUTE", engagementModel: "commission", commissionMode: "percent", commissionValue: 70, reason: "Old form still posting a percentage" });
  assert.equal(legacyForm.status, 400);
  assert.match((await legacyForm.json()).error, /set for each service in the provider's commercial terms/);
});
