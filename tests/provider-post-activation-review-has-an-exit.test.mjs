/*
 * A provider sent back for re-review could never return to the service map.
 *
 * A review-sensitive post-activation edit sets the application to `post_activation_review` and the
 * capacity profile to `uat_review, live=0` - deliberately, so a provider under re-review takes no new
 * bookings. But nothing in the repository ever moved a profile off `uat_review`, and
 * addProviderToServiceMap refuses it. MEASURED before this fix, against the real engine:
 *
 *   addProviderToServiceMap -> "Provider capacity profile has status 'uat_review', not ready to go live"
 *   status afterwards       -> uat_review, live 0     (and no code path anywhere could change it)
 *
 * lib/provider-verification-mandate.ts already says so in a comment - it routes through `uat_ready`
 * because `uat_review` "would be a dead end: nothing clears it". This is the door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__REVIEW_EXIT_DB__");

const OPS = "ops@pawspace.in";

async function world() {
  const harness = freshCountingD1();
  globalThis.__REVIEW_EXIT_DB__ = harness.db;
  const human = await import("../lib/provider-onboarding-human-activation.ts");
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await human.ensureProviderOnboardingHumanActivation(harness.db);
  await capacity.ensureProviderCapacityTables(harness.db);
  return { ...harness, human };
}

/** A provider who was activated and has since been dropped into post-activation review. */
async function satisfyMandate(harness) {
  const { verificationMandateStatus } = await import("../lib/provider-verification-mandate.ts");
  const before = await verificationMandateStatus(harness.db, { applicationId: "POAPP-REVIEW", category: "host" });
  const columns = harness.sqlite.prepare("PRAGMA table_info(provider_verifications)").all();
  const now = Date.now();
  for (const type of before.required) {
    const named = { id: `PV-${type}`, application_id: "POAPP-REVIEW", verification_type: type, status: "verified", automated: 0 };
    const row = {};
    for (const column of columns) {
      if (column.name in named) { row[column.name] = named[column.name]; continue; }
      if (column.dflt_value !== null || column.notnull === 0) continue;
      row[column.name] = /_at$|_ts$/.test(column.name) || /INT/i.test(column.type) ? now : "{}";
    }
    const use = Object.keys(row);
    harness.sqlite.prepare(`INSERT INTO provider_verifications (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`)
      .run(...use.map((c) => row[c]));
  }
  const after = await verificationMandateStatus(harness.db, { applicationId: "POAPP-REVIEW", category: "host" });
  assert.ok(after.canTakeAssignments, `the fixture must really satisfy the mandate, still pending: ${after.pending.join(", ")}`);
}

function underReview(harness, { mandateSatisfied }) {
  const now = Date.now();
  harness.sqlite.prepare("INSERT INTO provider_capacity_profiles (id,name,provider_model,city_id,zones_json,services_json,status,live,rating,quality_score,version,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PRV-REVIEW", "Under Review", "commission", "blr", JSON.stringify(["blr-east"]), JSON.stringify(["boarding"]), "uat_review", 0, 4.5, 80, 1, now, OPS, now);
  const named = { id: "POAPP-REVIEW", status: "post_activation_review", provider_id: "PRV-REVIEW",
    vertical_key: "boarding", city_code: "blr", country_code: "IN" };
  const columns = harness.sqlite.prepare("PRAGMA table_info(provider_onboarding_applications)").all();
  const row = {};
  for (const column of columns) {
    if (column.name in named) { row[column.name] = named[column.name]; continue; }
    if (column.dflt_value !== null || column.notnull === 0) continue;
    row[column.name] = /_at$|_ts$/.test(column.name) || /INT/i.test(column.type) ? now : "{}";
  }
  const use = Object.keys(row);
  harness.sqlite.prepare(`INSERT INTO provider_onboarding_applications (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`)
    .run(...use.map((c) => row[c]));
  return harness;
}

test("REVIEW-EXIT-1: the dead end is real - the service map refuses a profile in review", async () => {
  const w = await world();
  underReview(w, { mandateSatisfied: true });
  await assert.rejects(
    () => w.human.addProviderToServiceMap(w.db, { providerId: "PRV-REVIEW", zoneIds: ["blr-east"], actorEmail: OPS }),
    /uat_review/,
    "the premise of this test: a provider in review cannot be re-listed",
  );
});

test("REVIEW-EXIT-2: clearing the review returns the provider to a re-listable state", async () => {
  const w = await world();
  underReview(w, { mandateSatisfied: true });
  await satisfyMandate(w);
  const result = await w.human.clearPostActivationReview(w.db, { applicationId: "POAPP-REVIEW", actorEmail: OPS, note: "Service areas re-checked with the host" });
  assert.equal(result.capacityStatus, "uat_ready");
  const profile = w.sqlite.prepare("SELECT status,live FROM provider_capacity_profiles WHERE id='PRV-REVIEW'").get();
  assert.equal(profile.status, "uat_ready", "the dead-end status is gone");
  assert.equal(profile.live, 0, "clearing the review must NOT silently re-list them - that is a separate decision");
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_onboarding_applications WHERE id='POAPP-REVIEW'").get().status, "activated_uat");
  let relistRefusal = "";
  try {
    await w.human.addProviderToServiceMap(w.db, { providerId: "PRV-REVIEW", zoneIds: ["blr-east"], actorEmail: OPS });
  } catch (error) { relistRefusal = String(error?.message ?? error); }
  assert.doesNotMatch(relistRefusal, /uat_review|not ready to go live/,
    `re-listing must no longer be blocked by the review itself; it refused with: ${relistRefusal || "(accepted)"}`);
});

test("REVIEW-EXIT-3: it is not a rubber stamp", async () => {
  const w = await world();
  underReview(w, { mandateSatisfied: false });
  await assert.rejects(
    () => w.human.clearPostActivationReview(w.db, { applicationId: "POAPP-REVIEW", actorEmail: OPS, note: "Looks fine to me" }),
    /Verification is not current/,
    "returning to the map cannot be a weaker check than getting there",
  );
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_capacity_profiles WHERE id='PRV-REVIEW'").get().status, "uat_review",
    "a refused clear must leave the provider exactly where they were");
});

test("REVIEW-EXIT-4: it needs a stated reason, and only applies to an application actually in review", async () => {
  const w = await world();
  underReview(w, { mandateSatisfied: true });
  await satisfyMandate(w);
  await assert.rejects(() => w.human.clearPostActivationReview(w.db, { applicationId: "POAPP-REVIEW", actorEmail: OPS, note: "ok" }), /clear reason/);
  w.sqlite.prepare("UPDATE provider_onboarding_applications SET status='activated_uat' WHERE id='POAPP-REVIEW'").run();
  await assert.rejects(() => w.human.clearPostActivationReview(w.db, { applicationId: "POAPP-REVIEW", actorEmail: OPS, note: "Nothing to clear here" }), /not in post-activation review/);
});
