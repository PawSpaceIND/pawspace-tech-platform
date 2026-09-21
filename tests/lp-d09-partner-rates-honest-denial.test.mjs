/**
 * LP-D09 - /partner/rates printed the server's raw "Permission denied" for every one of four test
 * identities, including the commission Boarding/Sitting partners the page is meant for.
 *
 * Reading the route (app/api/provider-service-rates/route.ts) and running it for real against an
 * in-memory D1 shows the route itself is already correctly scoped: GET returns 200 with priceable
 * options for a genuine commission Boarding/Sitting provider platform session, and 200 with an empty
 * options list (already explained on the page) for a signed-in provider who is not commission-eligible
 * (e.g. a full-time groomer, who has no boarding/pet_sitting commercial term at all). A 403 - and the
 * literal string "Permission denied" is requirePermission's own message - only happens for a caller with
 * no recognized provider platform session at all (a staff sign-in, or no session), which IS the intended
 * gate: this page is a provider's own self-price session, never a staff read.
 *
 * Per the finding's instruction ("either the route admits the provider roles it was designed for, or the
 * page explains who can self-price. Do not widen access beyond the intended roles"), the route's access
 * is left exactly as designed and verified below; the fix is that the page never shows the raw 403 text
 * and instead explains, in the same tone as its existing empty-options message, that self-pricing needs
 * an eligible provider session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__LPD09_DB__", "__LPD09_ENV__");

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  enterWorkersDbScope(db);
  globalThis.__LPD09_DB__ = db;
  globalThis.__LPD09_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-STAFF','asha.groomer1@pawspace.test','Asha','manager','active',?,?)").bind(now, now).run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT,zones_json TEXT)");
  return { db, sqlite };
}

async function providerCookie(db, { providerId, principalKey }) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, { identitySource: "partner_otp", principalType: "identity_subject", principalKey, subjectType: "provider", subjectId: providerId, verificationState: "verified", actorId: "lp-d09-test", reason: "Synthetic provider session fixture" });
  const issued = await issuePlatformSession(db, { bindingId: binding.id, identitySource: "partner_otp", principalType: "identity_subject", principalKey, subjectType: "provider", subjectId: providerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const STAFF_HEADERS = {
  "oai-authenticated-user-email": "asha.groomer1@pawspace.test",
  "oai-authenticated-user-full-name": "Asha",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

test("LP-D09: a staff sign-in with no provider session gets a governed 403 (requirePermission's own text)", async () => {
  await world();
  const route = await import("../app/api/provider-service-rates/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/provider-service-rates", { headers: STAFF_HEADERS }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(String(body.error), /Permission denied/);
});

test("LP-D09: a commission Pet Sitting provider's OWN session gets 200 with priceable options - the route is not the bug", async () => {
  const { db } = await world();
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('T1','pet_sitting','sit_sana',1,'active','commission_standard',.70,'provider_gst_on_behalf',.18,0,0,0,12,'2026-01-01','probe','maker','checker','TEST',?,?)").bind(now, now).run();
  await db.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,zones_json) VALUES ('sit_sana','blr','[\"blr-east\"]')").run();
  const cookie = await providerCookie(db, { providerId: "sit_sana", principalKey: "uat-provider:sit_sana" });
  const route = await import("../app/api/provider-service-rates/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/provider-service-rates", { headers: { cookie } }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.ok(body.data.options.length > 0, "an eligible commission sitter must see priceable packages");
  assert.ok(body.data.options.every(option => option.serviceCode === "pet_sitting"));
});

test("LP-D09: a signed-in but non-commission provider (e.g. full-time groomer) gets 200 with an empty option list, not a 403", async () => {
  const { db } = await world();
  await db.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,zones_json) VALUES ('groom_9000000901','blr','[\"blr-east\"]')").run();
  const cookie = await providerCookie(db, { providerId: "groom_9000000901", principalKey: "partner_otp:9000000901" });
  const route = await import("../app/api/provider-service-rates/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/provider-service-rates", { headers: { cookie } }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.deepEqual(body.data.options, [], "a full-time groomer has no boarding/pet_sitting commercial term, so no self-pricing options - never a 403");
});

test("LP-D09: /partner/rates never shows the raw server 403 text; it explains who can self-price", async () => {
  const page = await readFile(new URL("../app/partner/rates/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if\(r\.status===403\)\{setNotEligible\(true\);setOptions\(\[\]\);setRates\(\[\]\);return;\}/,
    "a 403 must be recognised before the raw body.error is ever read into state");
  assert.match(page, /\{notEligible&&<article[^>]*>This page is for a signed-in commission Boarding\/Sitting partner/,
    "an honest explanation must render instead of the alert banner for a 403");
  assert.doesNotMatch(page, /setError\(b\.error\|\|"Unable to load rates"\)/, "the 403 path must not fall through to the raw-error alert");
});
