import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const client = await read("../lib/haptik-outbound-client.ts");
const gov = await read("../lib/haptik-outbound-governance.ts");
const route = await read("../app/api/haptik-outbound/route.ts");
const scheduler = await read("../lib/background-scheduler.ts");

test("Haptik outbound client is a fail-closed adapter (dials nothing until keys are set)", () => {
  assert.match(client, /export function haptikOutboundConfigured/);
  assert.match(client, /export async function triggerHaptikCall/);
  assert.match(client, /HAPTIK_OUTBOUND_API_KEY/);
  assert.match(client, /HAPTIK_OUTBOUND_URL/);
  assert.match(client, /if \(!key \|\| !url\) return \{ connected: false/);
});

test("Haptik outbound network boundary blocks SSRF, redirects and slow requests", () => {
  assert.match(client, /HAPTIK_OUTBOUND_TIMEOUT_MS=2500/);
  assert.match(client, /new AbortController\(\)/);
  assert.match(client, /signal:controller\.signal/);
  assert.match(client, /redirect:"error"/);
  assert.match(client, /haptikapi\.com/);
  assert.match(client, /hellohaptik\.com/);
  assert.match(client, /host==="localhost"/);
  assert.match(client, /a===10/);
  assert.match(client, /a===127/);
  assert.match(client, /a===169&&b===254/);
  assert.match(client, /a===192&&b===168/);
  assert.match(client, /a===172&&b>=16&&b<=31/);
  assert.match(client, /url\.protocol!=="https:"/);
  assert.match(client, /isAllowedHaptikOutboundUrl\(url\)/);
});

test("Haptik outbound governance: campaigns, consent + responsible-outbound guardrails", () => {
  assert.match(gov, /export const HAPTIK_CAMPAIGNS/);
  for (const c of ["new_lead_followup", "reactivation", "subscription_pitch"]) assert.match(gov, new RegExp(`code\\s*:\\s*"${c}"`));
  assert.match(gov, /requiresMarketingConsent\s*:\s*true/);
  assert.match(gov, /p\.marketing_consent=1/);
  assert.match(gov, /if\s*\(!haptikOutboundConfigured\(env\)\)\s*return/);
  assert.match(gov, /isQuietHours/);
  assert.match(gov, /FREQUENCY_CAP_DAYS/);
  assert.match(gov, /status='dialled' AND created_at>\?/);
  assert.match(gov, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(gov, /already_dialled_today/);
});

test("the scheduler sweep NEVER autonomously dials (outreach is human-launched only)", () => {
  assert.match(gov, /export async function runHaptikOutboundSweep/);
  assert.match(gov, /dialled\s*:\s*0/);
  assert.match(gov, /human-launched/i);
  assert.doesNotMatch(gov.split("runHaptikOutboundSweep")[1] || "", /triggerHaptikCall\(/);
  assert.match(scheduler, /runHaptikOutboundSweep/);
  assert.match(scheduler, /"haptikOutbound"/);
});

test("the outbound route is permission-gated (marketing.manage to trigger)", () => {
  assert.match(route, /requirePermission\(actor,"marketing\.view"\)/);
  assert.match(route, /requirePermission\(actor,"marketing\.manage"\)/);
  assert.match(route, /triggerOutboundCampaign/);
  assert.match(route, /sameOrigin\(request\)/);
});
