/*
 * /partner/rates and /partner/funeral: two screens nothing links to, audited by driving them.
 *
 * Two defects on the pricing screen, both proved through the real route with a real partner session:
 *
 *   R1  Every refusal in lib/provider-service-pricing.ts was a bare Error, so authError() answered
 *       500 "Unable to save provider service rate" and threw the reason away. The partner who typed a
 *       price below the PawSpace minimum was told the platform had broken, not that their number was
 *       too low - and the message that names the minimum was the one discarded.
 *
 *   R2  POST took cityId and zoneId FROM THE REQUEST BODY even for a provider session, while the GET
 *       that renders the screen derives them from the partner's own capacity profile. A partner could
 *       therefore publish a rate into a zone they do not serve, with the PawSpace floor resolved for
 *       that other zone - the one input in this flow that decides whether a price is legal.
 *
 * And on the funeral screen, the "Call customer" button carried no handler at all: enabling it (its
 * readiness flag is hard-coded false today) would have produced a control that posts nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__W2F_RATES_DB__");

const PROVIDER = "prv_w2f_rates";
const STAFF = "pricing.ops@pawspace.in";

async function providerSession(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: `uat-provider:${providerId}`,
    subjectType: "provider", subjectId: providerId, actorId: "test", reason: "w2f rates fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: `uat-provider:${providerId}`, subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function fixture() {
  const { sqlite, db } = world("__W2F_RATES_DB__", "__W2F_RATES_DB___ENV", {});
  const auth = await import("../lib/server-auth.ts");
  const terms = await import("../lib/provider-commercial-terms.ts");
  const boarding = await import("../lib/boarding-governance.ts");
  const capacity = await import("../lib/provider-capacity-governance.ts");
  const pricing = await import("../lib/provider-service-pricing.ts");
  const { ensurePlatformSessionTables } = await import("../lib/platform-session.ts");
  await auth.ensureSecurityTables(db);
  await ensurePlatformSessionTables(db);
  await terms.ensureCommercialTermsTables(db);
  await boarding.ensureBoardingGovernanceTables(db);
  await capacity.ensureProviderCapacityTables(db);
  await pricing.ensureProviderServicePricingTables(db);
  await seedActors(sqlite, db, [{ id: "U-PRICE", email: STAFF, role: "superuser" }]);

  const now = Date.now();
  await db.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('TERM-W2F','boarding',?,1,'active','commission_standard',.70,'provider_gst_on_behalf',.18,0,0,0,12,'2026-01-01','w2f rates fixture','maker','checker','TEST',?,?)")
    .bind(PROVIDER, now, now).run();
  // The partner's real capacity profile: Bengaluru, east zone, live and assignable.
  sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,0,0,2,30,6,3,'active',1,?,NULL,?,?)")
    .run(PROVIDER, "blr", "W2F Boarding", "commission", JSON.stringify(["boarding"]), JSON.stringify(["blr-east"]), new Date(now).toISOString().slice(0, 10), STAFF, now);
  return { sqlite, db, cookie: await providerSession(db, PROVIDER) };
}

const post = async (cookie, body) => {
  const { POST } = await import("../app/api/provider-service-rates/route.ts");
  return POST(new Request(`${ORIGIN}/api/provider-service-rates`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
};
const get = async (cookie) => {
  const { GET } = await import("../app/api/provider-service-rates/route.ts");
  return GET(new Request(`${ORIGIN}/api/provider-service-rates`, { headers: { cookie } }));
};

test("W2F-R1 a price below the PawSpace minimum is refused as a 4xx that names the minimum", async () => {
  const { cookie } = await fixture();
  const view = await get(cookie);
  assert.equal(view.status, 200, await view.clone().text());
  const options = (await view.json()).data.options;
  assert.ok(options.length, "a commission boarding partner must be offered packages to price");
  const option = options[0];

  const refused = await post(cookie, { serviceCode: option.serviceCode, packageCode: option.packageCode, cityId: option.cityId, zoneId: option.zoneId, rate: 1 });
  assert.ok(refused.status >= 400 && refused.status < 500, `a price that is too low is the partner's own input, not a server fault (got ${refused.status})`);
  assert.match((await refused.json()).error, /minimum/i, "and the partner must be told what the minimum is");

  const accepted = await post(cookie, { serviceCode: option.serviceCode, packageCode: option.packageCode, cityId: option.cityId, zoneId: option.zoneId, rate: option.floorPrice + 250 });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await accepted.json()).data.rate, option.floorPrice + 250);
});

test("W2F-R2 a partner cannot publish a rate into a zone they do not serve", async () => {
  const { sqlite, cookie } = await fixture();
  const option = (await (await get(cookie)).json()).data.options[0];

  const response = await post(cookie, { serviceCode: option.serviceCode, packageCode: option.packageCode, cityId: "goa", zoneId: "goa-north", rate: option.floorPrice + 100 });
  if (response.ok) {
    const saved = (await response.json()).data;
    assert.equal(saved.cityId, option.cityId, "the saved rate must be scoped to the partner's own city, not one they typed");
    assert.equal(saved.zoneId, option.zoneId, "the saved rate must be scoped to the partner's own zone, not one they typed");
  } else {
    assert.ok(response.status >= 400 && response.status < 500, `refusing is fine, a 500 is not (got ${response.status})`);
  }
  const foreign = sqlite.prepare("SELECT COUNT(*) n FROM provider_service_rates WHERE provider_id=? AND zone_id='goa-north'").get(PROVIDER).n;
  assert.equal(Number(foreign), 0, "no rate may exist in a zone this partner's capacity profile does not cover");
});

test("W2F-R4 every screen this agent touched still renders", async () => {
  // Cheap, but it executes the components: a control added to a minified page that throws on render
  // takes the whole screen down, and no route test would notice.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  for (const path of [
    "../app/team/provider-onboarding/page.tsx", "../app/team/provider-verification/page.tsx",
    "../app/control/provider-onboarding/page.tsx", "../app/partner/onboarding/page.tsx",
    "../app/partner/funeral/page.tsx", "../app/partner/rates/page.tsx",
  ]) {
    const mod = await import(path);
    assert.ok(renderToStaticMarkup(createElement(mod.default)).length > 0, `${path} must render`);
  }
});

test("W2F-R3 the funeral partner screen has no control that posts nothing", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../app/partner/funeral/page.tsx", import.meta.url), "utf8");
  const buttons = source.match(/<button[\s\S]*?>/g) || [];
  const dead = buttons.filter((b) => !b.includes("onClick") && !b.includes("disabled"));
  assert.deepEqual(dead, [], "every button must either do something or say why it cannot");
  // The one that carried no handler at all: it must no longer be presented as an action.
  assert.ok(!/Call customer/.test(source) || /onClick/.test(source.slice(source.indexOf("Call customer") - 300, source.indexOf("Call customer") + 50)),
    "a 'Call customer' affordance must post something, or not be a button");
});
