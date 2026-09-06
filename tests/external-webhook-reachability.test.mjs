import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const gateway = read("lib/api-gateway.ts");

const exemptPaths = new Set([...gateway.matchAll(/url\.pathname==="(\/api\/[a-z0-9-]+)"/g)]
  .map(match => match[1])
  .filter(path => {
    const index = gateway.indexOf(`url.pathname==="${path}"`);
    const firstReturnNull = gateway.indexOf("return null;");
    return index < firstReturnNull;
  }));

const routeFiles = fs.readdirSync(new URL("../app/api", import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => fs.existsSync(new URL(`../app/api/${name}/route.ts`, import.meta.url)));

const libSource = new Map();
function readLib(name) {
  if (libSource.has(name)) return libSource.get(name);
  let source = "";
  try { source = read(`lib/${name}.ts`); } catch { source = ""; }
  libSource.set(name, source);
  return source;
}
function reachableModules(routeName) {
  const start = read(`app/api/${routeName}/route.ts`);
  const parts = [start];
  const seen = new Set(), queue = [];
  const enqueue = (source) => {
    for (const match of source.matchAll(/from\s*["'](\.[^"']*)["']/g)) {
      const name = match[1].split("/").pop().replace(/\.ts$/, "");
      if (name && !seen.has(name)) { seen.add(name); queue.push(name); }
    }
  };
  enqueue(start);
  while (queue.length) {
    const name = queue.shift();
    const source = readLib(name);
    if (!source) continue;
    parts.push(source);
    enqueue(source);
  }
  return parts;
}

function externalAuth(source) {
  const signals = [];
  if (/env\.[A-Z_]*API_KEY|runtime\.[A-Z_]*API_KEY|[A-Z_]+_API_KEY\s*\|\|/.test(source) && /request\.headers\.get\(/.test(source)) signals.push("shared_key_header");
  if (/(?:WEBHOOK_SECRET|HAPTIK_API_KEY)/.test(source)
    && /crypto\.subtle\.(sign|importKey)/.test(source)
    && /headers\.get\(/.test(source)
    && /safeEqual|timingSafeEqual|constantTimeEqual/.test(source)) signals.push("hmac_signature");
  if (/x-razorpay-signature|x-pawspace-signature|x-hub-signature/i.test(source)) signals.push("provider_signature_header");
  return signals;
}

test("every route that authenticates an external caller is reachable through the gateway", () => {
  const unreachable = [];
  for (const name of routeFiles) {
    const source = read(`app/api/${name}/route.ts`);
    if (/\bauthorize\(/.test(source)) continue;
    const signals = externalAuth(source);
    if (!signals.length) continue;
    if (!exemptPaths.has(`/api/${name}`)) unreachable.push(`/api/${name} (authenticates via ${signals.join("+")})`);
  }
  assert.deepEqual(unreachable, [], `these webhooks answer 401 from the gateway before their own credential check runs:\n  ${unreachable.join("\n  ")}`);
});

test("the Haptik voice webhook is reachable and fail-closed on raw-body HMAC", () => {
  assert.ok(exemptPaths.has("/api/haptik"), "Haptik's voice bot must be able to reach its own webhook");
  const source = read("app/api/haptik/route.ts");
  assert.match(source, /HAPTIK_API_KEY/);
  assert.match(source, /x-hub-signature/);
  assert.match(source, /request\.text\(\)/);
  assert.match(source, /crypto\.subtle\.importKey/);
  assert.match(source, /safeEqual\(expected,provided\)/);
  assert.match(source, /Haptik integration is not connected[\s\S]*503/);
  assert.match(source, /Invalid Haptik credentials[\s\S]*401/);
  assert.doesNotMatch(source, /x-haptik-key|authorization/i);
  for (const action of ["capture_lead", "capture_callback", "fetch_slots", "request_booking", "record_call_outcome"]) {
    assert.ok(source.includes(`"${action}"`), `the Haptik webhook must serve ${action}`);
  }
});

test("the WhatsApp inbound webhook is reachable and fail-closed on its signature", () => {
  assert.ok(exemptPaths.has("/api/whatsapp-uat-webhook"), "the WhatsApp provider must be able to deliver inbound messages");
  const source = read("app/api/whatsapp-uat-webhook/route.ts");
  assert.match(source, /PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET/);
  assert.match(source, /webhook secret is not configured[\s\S]*503/);
  assert.match(source, /Invalid WhatsApp UAT webhook signature[\s\S]*401/);
  assert.match(source, /safeEqual\(expected,signature\)/, "signatures are compared in constant time");
});

test("no gateway-exempt route is left without any caller authentication", () => {
  const knownPublicSurfaces = new Set([
    "/api/pricing-quote", "/api/training-commercial", "/api/training-trainers", "/api/boarding-commercial",
    "/api/sitting-commercial", "/api/taxi-commercial", "/api/food-commercial", "/api/walking-commercial",
    "/api/identity-session", "/api/service-availability", "/api/public-contact", "/api/inquiries", "/api/provider-public-profile",
    "/api/staging-login", "/api/customer-offers", "/api/host-profile", "/api/customer-otp", "/api/customer-profile",
    "/api/customer-account", "/api/booking-rating", "/api/customer-support-case", "/api/live-price-quote",
    "/api/training-requirements", "/api/host-trust", "/api/service-zone", "/api/partner-otp", "/api/pet-passport-public",
  ]);
  const unguarded = [];
  for (const path of exemptPaths) {
    if (knownPublicSurfaces.has(path)) continue;
    const name = path.replace("/api/", "");
    if (!fs.existsSync(new URL(`../app/api/${name}/route.ts`, import.meta.url))) continue;
    if (reachableModules(name).some(source => externalAuth(source).length)) continue;
    unguarded.push(path);
  }
  assert.deepEqual(unguarded, [], `gateway-exempt with no caller authentication at all: ${unguarded.join(", ")}`);
});

test("the telephony callback is reachable and fail-closed on its verification", () => {
  assert.ok(exemptPaths.has("/api/voice-provider-webhook"), "a carrier has no session and must be able to deliver call events");
  const provider = read("lib/voice-telephony-provider.ts");
  assert.match(provider, /EXOTEL_WEBHOOK_SECRET/);
  assert.match(provider, /crypto\.subtle\.importKey/);
  assert.match(provider, /function safeEqual/, "signatures are compared in constant time");
  assert.match(provider, /Webhook secret is not configured/);
  const route = read("app/api/voice-provider-webhook/route.ts");
  assert.match(route, /recordVoiceProviderEvent/);
  assert.doesNotMatch(route, /\bauthorize\(/, "the callback must not require a staff session");
});

test("following imports did not turn the exemption guard into a rubber stamp", () => {
  assert.deepEqual(externalAuth("export async function POST(){return Response.json({ok:true})}"), []);
  const halfA = "const secret = env.EXOTEL_WEBHOOK_SECRET; export const x = secret; const h = request.headers.get('x-sig'); function safeEqual(a,b){return a===b}";
  const halfB = "export async function sign(k){ return crypto.subtle.importKey('raw', k); }";
  assert.deepEqual(externalAuth(halfA), [], "a secret plus a header read, with no signing, is not verification");
  assert.deepEqual(externalAuth(halfB), [], "a signing helper alone is not verification");
  assert.ok(externalAuth([halfA, halfB].join("\n")).includes("hmac_signature"), "joined, the halves would have passed");
});

test("Meta WhatsApp webhook is gateway-reachable and retains provider verification", () => {
  assert.match(gateway, /url\.pathname==="\/api\/whatsapp\/meta-webhook"/);
  const source = read("app/api/whatsapp/meta-webhook/route.ts");
  assert.match(source, /META_WHATSAPP_VERIFY_TOKEN/);
  assert.match(source, /META_WHATSAPP_APP_SECRET/);
  assert.match(source, /x-hub-signature-256/);
  assert.match(source, /verifyMetaWhatsAppSignature/);
});
