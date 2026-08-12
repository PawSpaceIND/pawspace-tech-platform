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
  // gated on BOTH an api key and a url; missing either => connected:false, no fetch
  assert.match(client, /HAPTIK_OUTBOUND_API_KEY/);
  assert.match(client, /HAPTIK_OUTBOUND_URL/);
  assert.match(client, /if \(!key \|\| !url\) return \{ connected: false/);
});

test("Haptik outbound governance: campaigns, consent + responsible-outbound guardrails", () => {
  assert.match(gov, /export const HAPTIK_CAMPAIGNS/);
  for (const c of ["new_lead_followup", "reactivation", "subscription_pitch"]) assert.match(gov, new RegExp(`code: "${c}"`));
  // marketing campaigns require marketing consent
  assert.match(gov, /requiresMarketingConsent: true/);
  assert.match(gov, /p\.marketing_consent=1/);
  // guardrails: fail-closed, quiet hours, frequency cap, idempotency
  assert.match(gov, /if \(!haptikOutboundConfigured\(env\)\) return/);
  assert.match(gov, /isQuietHours/);
  assert.match(gov, /FREQUENCY_CAP_DAYS/);
  assert.match(gov, /status='dialled' AND created_at>\?/);   // frequency cap query
  assert.match(gov, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(gov, /already_dialled_today/);
});

test("the scheduler sweep NEVER autonomously dials (outreach is human-launched only)", () => {
  assert.match(gov, /export async function runHaptikOutboundSweep/);
  assert.match(gov, /dialled: 0/);
  assert.match(gov, /human-launched/i);
  // the sweep must not call the dialer
  assert.doesNotMatch(gov.split("runHaptikOutboundSweep")[1] || "", /triggerHaptikCall\(/);
  // wired into the background scheduler under a stable name
  assert.match(scheduler, /runHaptikOutboundSweep/);
  assert.match(scheduler, /"haptikOutbound"/);
});

test("the outbound route is permission-gated (marketing.manage to trigger)", () => {
  assert.match(route, /requirePermission\(actor,"marketing\.view"\)/);
  assert.match(route, /requirePermission\(actor,"marketing\.manage"\)/);
  assert.match(route, /triggerOutboundCampaign/);
  assert.match(route, /sameOrigin\(request\)/);
});
