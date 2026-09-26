// One-off staging operation, requested by the owner on 26 Sep 2026: publish the canonical V2 Grooming price list
// in Pricing Control, so the V2 grooming catalogue is no longer empty (master E2E finding SVC-GRM-01).
// It runs only when named explicitly in e2e/master/SUITE (files starting with "_" are never part of "all").
// Idempotent: packages already published are left alone. Prices are not changed, only activated, and every
// change goes through the audited Pricing Control API with a reason, exactly as the Pricing Control screen does.
import { BASE, launch, newFlow, settle, staffSession, customerSession, dismissCookies, api, record, finding, writeJson, runPhone } from "../lib.mjs";

const SUITE = "_ops-publish-grooming";
const REASON = "Publish the canonical V2 grooming price list on staging (owner request, 26 Sep 2026; master E2E SVC-GRM-01)";
const out = { suite: SUITE, before: [], published: [], alreadyActive: [], errors: [], catalogue: null };
const browser = await launch();
try {
  const ops = await newFlow(browser, "_ops-publish-grooming");
  try {
    await staffSession(ops.context, "founder@pawspace.in");
    const list = await api(ops.context, "GET", "/api/pricing-control");
    if (list.status !== 200) throw new Error(`pricing-control GET ${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
    const grooming = (list.body?.data?.packages || []).filter(p => p.service_code === "grooming" && String(p.id).startsWith("canonical_groom_"));
    out.before = grooming.map(p => ({ id: p.id, packageCode: p.package_code, price: p.base_price, active: Number(p.active) }));
    for (const p of grooming) {
      if (Number(p.active) === 1) { out.alreadyActive.push(p.id); continue; }
      const r = await api(ops.context, "PATCH", "/api/pricing-control", { entity: "package", id: p.id, changes: { active: 1 }, reason: REASON });
      if (r.status === 200) out.published.push({ id: p.id, packageCode: p.package_code, price: p.base_price });
      else out.errors.push({ id: p.id, status: r.status, error: JSON.stringify(r.body?.error ?? r.body).slice(0, 200) });
    }
    record({ suite: SUITE, journey: "Publish V2 grooming price list", combo: `${grooming.length} canonical grooming packages`, result: out.errors.length ? "FAIL" : "PASS", detail: `published ${out.published.length}, already active ${out.alreadyActive.length}, errors ${out.errors.length} ${JSON.stringify(out.errors).slice(0, 300)}`, evidence: [] });
    await ops.page.goto(`${BASE}/control`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await dismissCookies(ops.page); await settle(ops.page, 1500);
    await ops.shot("control-after-publish");
  } catch (e) { record({ suite: SUITE, journey: "Publish V2 grooming price list", combo: "founder", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await ops.close();

  // What a customer now sees.
  const cus = await newFlow(browser, "_ops-grooming-customer-view");
  try {
    const account = await customerSession(cus.context, "customer-a");
    await api(cus.context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `groom-pet-${runPhone(1)}`, pet: { name: "GroomDog", species: "dog", breed: "Indie", vaccinationStatus: "verified" } });
    const cat = await api(cus.context, "GET", "/api/v2/grooming-catalogue");
    const packages = cat.body?.data?.packages || [];
    out.catalogue = { status: cat.status, count: packages.length, sample: packages.map(p => ({ code: p.code, name: p.name, audience: p.audience, prices: (p.bundles || []).map(b => `${b.petCount} pet: ₹${b.price}`) })) };
    await cus.page.goto(`${BASE}/v2/grooming`, { waitUntil: "domcontentloaded" });
    await dismissCookies(cus.page); await settle(cus.page, 2500);
    await cus.page.getByText("GroomDog", { exact: false }).first().click({ timeout: 10_000 }).catch(() => {});
    await settle(cus.page, 1500);
    const shot = await cus.shot("v2-grooming-after-publish");
    record({ suite: SUITE, journey: "V2 grooming catalogue after publish", combo: "customer view", result: cat.status === 200 && packages.length ? "PASS" : "FAIL", detail: JSON.stringify(out.catalogue).slice(0, 600), evidence: [shot] });
    if (!(cat.status === 200 && packages.length)) finding({ suite: SUITE, severity: "P1", area: "Grooming (V2)", persona: "Customer", flow: "Grooming catalogue", title: "V2 grooming catalogue still empty after the price list was published", steps: "Publish canonical grooming packages, GET /api/v2/grooming-catalogue", expected: "published packages listed", actual: JSON.stringify(cat.body).slice(0, 300), evidence: [shot] });
  } catch (e) { record({ suite: SUITE, journey: "V2 grooming catalogue after publish", combo: "customer view", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await cus.close();
} finally {
  writeJson("ops-publish-grooming.json", out);
  await browser.close();
}
