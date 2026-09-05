import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Vercel explicitly hands application-owned Elite and Meta routes to the Cloudflare origin proxy", () => {
  const config = read("backend/vercel.json");
  const entry = read("backend/vercel-entry.ts");
  for (const route of ["/api/whatsapp/meta-webhook", "/api/elite-runtime", "/api/elite-surge-preview"]) {
    assert.match(config, new RegExp(route.replaceAll("/", "\\/")));
    assert.match(entry, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(entry, /PAWSPACE_APPLICATION_ORIGIN/);
  assert.match(entry, /vercel-fastify-to-cloudflare/);
  assert.match(entry, /APPLICATION_ORIGIN_UNAVAILABLE/);
});

test("Cloudflare worker keeps Meta dispatch after shared API composition and delegates provider authentication to HMAC verification", () => {
  const worker = read("worker/index.ts");
  const route = read("app/api/whatsapp/meta-webhook/route.ts");
  assert.match(worker, /isMetaWebhook=url\.pathname==="\/api\/whatsapp\/meta-webhook"/);
  assert.match(worker, /runEliteWebhookHooks/);
  assert.match(worker, /const response = await handler\.fetch\(request, env, ctx\)/);
  assert.match(route, /verifyMetaWhatsAppSignature/);
  assert.match(route, /status:401/);
  assert.match(route, /status:403/);
});

test("Elite service wiring declares CRM extraction, deal closer, churn and surge call-sites without direct financial execution", () => {
  const runtime = read("lib/services/elite-runtime.ts");
  const worker = read("worker/index.ts");
  assert.match(runtime, /extractAndApplyCrmEntities\(/);
  assert.match(runtime, /runAutonomousDealCloser\(/);
  assert.match(runtime, /scorePredictiveChurn\(/);
  assert.match(runtime, /calculateSurgePricing\(/);
  assert.match(worker, /runEliteScheduledHooks/);
  assert.match(runtime, /request\.requiresApproval !== true/);
  assert.match(runtime, /CHECK\(requires_approval=1\)/);
  assert.match(runtime, /pending_approval/);
  assert.doesNotMatch(runtime, /capturePayment\(|createPaymentOrder\(|executeRazorpayOrderOutbox\(/);
});

test("missing or revoked contact consent is wired fail-closed before autonomous deal outreach", () => {
  const runtime = read("lib/services/elite-runtime.ts");
  assert.match(runtime, /marketingOptOut: !consentKnown/);
  assert.match(runtime, /channelOptOut: !consentKnown/);
  assert.match(runtime, /dataQualityReviewRequired: !consentKnown/);
  assert.match(runtime, /contactSafety/);
});

test("surge route contract is preview-only and declares no customer price mutation", () => {
  const route = read("app/api/elite-surge-preview/route.ts");
  assert.match(route, /pricing\.manage/);
  assert.match(route, /mode: "preview_only"/);
  assert.match(route, /customerPriceMutation: false/);
});
