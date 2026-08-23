import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// External webhooks must be reachable by the external system, and only by it.
//
// The gateway (lib/api-gateway.ts) runs before every /api/* route and defaults
// unmapped paths to requiring a staff platform session. An inbound webhook
// authenticates itself with a shared key or an HMAC signature and has no
// session, so a webhook that is not on the gateway's public list is
// unreachable in EVERY environment - it answers 401 before its own credential
// check ever runs. That is exactly how the whole Haptik voice integration
// (capture_lead, capture_callback, fetch_slots, request_booking,
// record_call_outcome) and the WhatsApp inbound webhook were dead on arrival.
//
// This guard runs in both directions:
//   1. a route that authenticates an external caller MUST be gateway-exempt
//   2. a gateway-exempt route MUST authenticate its callers somehow, so the
//      exemption list can never become a way to publish a staff endpoint
// ---------------------------------------------------------------------------
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const gateway = read("lib/api-gateway.ts");

// The literal list of paths requiredPermission() short-circuits to null.
const exemptPaths = new Set([...gateway.matchAll(/url\.pathname==="(\/api\/[a-z0-9-]+)"/g)]
  .map(match => match[1])
  .filter(path => {
    const index = gateway.indexOf(`url.pathname==="${path}"`);
    // Only count occurrences inside the leading public-path short-circuit, which ends at `return null;`
    const firstReturnNull = gateway.indexOf("return null;");
    return index < firstReturnNull;
  }));

const routeFiles = fs.readdirSync(new URL("../app/api", import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => fs.existsSync(new URL(`../app/api/${name}/route.ts`, import.meta.url)));

/**
 * The source a route's caller-authentication can live in: the route file plus every lib module it
 * reaches through relative imports.
 *
 * Originally this looked at the route file alone, which assumed webhook verification is always written
 * inline. /api/voice-provider-webhook verifies its callers through the telephony provider boundary
 * (lib/voice-telephony-provider.ts, shared with the simulator and exercised by
 * tests/voice-provider-webhook.test.mjs), so an inline-only scan reported it as unauthenticated - a
 * false positive that would push crypto back into the route to satisfy the check.
 *
 * This is a widening of WHERE the guard looks, not of WHAT counts: the signals below are unchanged, and
 * a route with no verification anywhere in its reachable source still fails. The sabotage case at the
 * end of this file proves that.
 */
const libSource = new Map();
function readLib(name) {
  if (libSource.has(name)) return libSource.get(name);
  let source = "";
  try { source = read(`lib/${name}.ts`); } catch { source = ""; }
  libSource.set(name, source);
  return source;
}
function reachableSource(routeName) {
  const start = read(`app/api/${routeName}/route.ts`);
  const parts = [start];
  const seen = new Set(), queue = [];
  // Route files import as "../../../lib/x"; lib modules import their siblings as "./x". Both resolve
  // to lib/x.ts, so the specifier is reduced to its basename.
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
  return parts.join("\n");
}

// A route authenticates an EXTERNAL caller when it verifies a shared key or an HMAC signature
// itself, rather than resolving a staff/customer session through authorize().
function externalAuth(source) {
  const signals = [];
  if (/env\.[A-Z_]*API_KEY|runtime\.[A-Z_]*API_KEY|[A-Z_]+_API_KEY\s*\|\|/.test(source) && /request\.headers\.get\(/.test(source)) signals.push("shared_key_header");
  if (/WEBHOOK_SECRET/.test(source) && /crypto\.subtle\.(sign|importKey)/.test(source)) signals.push("hmac_signature");
  if (/x-razorpay-signature|x-pawspace-signature|x-haptik-key/i.test(source)) signals.push("provider_signature_header");
  return signals;
}

test("every route that authenticates an external caller is reachable through the gateway", () => {
  // Deliberately inline-only, unlike the exemption check below: a staff route can reach a shared
  // verifier transitively without being a webhook, and demanding a gateway exemption for it would be
  // the opposite mistake - publishing a staff endpoint to satisfy a guard.
  const unreachable = [];
  for (const name of routeFiles) {
    const source = read(`app/api/${name}/route.ts`);
    // A route that resolves a platform session is a staff/customer route, not an inbound webhook,
    // even if it also reads provider keys for readiness checks (e.g. /api/system-integration).
    if (/\bauthorize\(/.test(source)) continue;
    const signals = externalAuth(source);
    if (!signals.length) continue;
    if (!exemptPaths.has(`/api/${name}`)) unreachable.push(`/api/${name} (authenticates via ${signals.join("+")})`);
  }
  assert.deepEqual(unreachable, [], `these webhooks answer 401 from the gateway before their own credential check runs:\n  ${unreachable.join("\n  ")}`);
});

test("the Haptik voice webhook is reachable and fail-closed on its own key", () => {
  assert.ok(exemptPaths.has("/api/haptik"), "Haptik's voice bot must be able to reach its own webhook");
  const source = read("app/api/haptik/route.ts");
  // Reachable is not the same as open: no key configured => 503, wrong key => 401.
  assert.match(source, /HAPTIK_API_KEY/);
  assert.match(source, /Haptik integration is not connected[\s\S]*503/);
  assert.match(source, /Invalid Haptik credentials[\s\S]*401/);
  // And every voice-agent action the bot needs is actually served.
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
  // A path on the public list must either authenticate an external caller itself, or be a
  // genuinely public surface (a price quote, a public profile, the customer OTP flow). A staff
  // endpoint reaching this list would be published to the internet with no credential at all.
  const knownPublicSurfaces = new Set([
    "/api/pricing-quote", "/api/training-commercial", "/api/training-trainers", "/api/boarding-commercial",
    "/api/sitting-commercial", "/api/taxi-commercial", "/api/food-commercial", "/api/walking-commercial",
    "/api/identity-session", "/api/service-availability", "/api/public-contact", "/api/provider-public-profile",
    "/api/staging-login", "/api/customer-offers", "/api/host-profile", "/api/customer-otp", "/api/customer-profile",
    "/api/customer-account", "/api/booking-rating", "/api/customer-support-case", "/api/live-price-quote",
    "/api/training-requirements", "/api/host-trust", "/api/service-zone", "/api/partner-otp", "/api/pet-passport-public",
  ]);
  const unguarded = [];
  for (const path of exemptPaths) {
    if (knownPublicSurfaces.has(path)) continue;
    const name = path.replace("/api/", "");
    if (!fs.existsSync(new URL(`../app/api/${name}/route.ts`, import.meta.url))) continue;
    if (externalAuth(reachableSource(name)).length) continue;
    unguarded.push(path);
  }
  assert.deepEqual(unguarded, [], `gateway-exempt with no caller authentication at all: ${unguarded.join(", ")}`);
});

test("the telephony callback is reachable and fail-closed on its verification", () => {
  assert.ok(exemptPaths.has("/api/voice-provider-webhook"), "a carrier has no session and must be able to deliver call events");
  // Reachable is not open. The receiver refuses with 401 unless a shared-secret signature or Basic
  // credential verifies, and it refuses outright when no secret is configured. Behaviour is executed in
  // tests/voice-provider-webhook.test.mjs; this only asserts the wiring the gateway depends on.
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
  // Sabotage: a route whose reachable source contains no verification of any kind must still be
  // reported. Without this, widening WHERE the guard looks could silently widen WHAT it accepts.
  assert.deepEqual(externalAuth("export async function POST(){return Response.json({ok:true})}"), []);
  // A staff route reached through the same import-following must not acquire a webhook's credentials.
  // /api/voice-outbound reaches lib/voice-telephony-provider transitively and IS gateway-mapped, so it
  // is the sharpest case: it must not be on the exempt list.
  assert.ok(!exemptPaths.has("/api/voice-outbound"), "a staff voice route must stay behind the gateway");
  assert.ok(!exemptPaths.has("/api/ai-voice-uat"));
  assert.ok(!exemptPaths.has("/api/voice-speech"));
  // And the exemption list itself must not have grown a staff surface: every exempt path either
  // authenticates an external caller or is on the known-public list asserted above.
  assert.ok(exemptPaths.size > 20 && exemptPaths.size < 40, `exempt list is ${exemptPaths.size} paths - review it if this moved a lot`);
});
