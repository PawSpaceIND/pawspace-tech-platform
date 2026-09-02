import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const haptikRoute = await read("../app/api/haptik/route.ts");
const interaktRoute = await read("../app/api/interakt/route.ts");
const configRoute = await read("../app/api/haptik-config/route.ts");
const outboundRoute = await read("../app/api/haptik-outbound/route.ts");
const consolePage = await read("../app/team/haptik/page.tsx");
const scheduler = await read("../lib/background-scheduler.ts");
const teamIndex = await read("../app/team/page.tsx");
const gateway = await read("../lib/api-gateway.ts");

// ---------------------------------------------------------------------------
// 1. The operator console's decisions, executed rather than inferred from markup.
// ---------------------------------------------------------------------------
const BASE = { connected: true, campaign: "winback", limit: 25, preview: null, quietHours: false };
const previewFor = (campaign, limit, size = 12) => ({ campaign, limit, size, at: Date.now() });

test("a launch is never the first click: it needs a preview for THIS campaign at THIS limit", async () => {
  const { campaignLaunchDecision } = await import("../lib/haptik-console.ts");
  assert.equal(campaignLaunchDecision(BASE).blockedBy, "preview_required");
  // A preview for a different campaign, or for a different limit, must not authorise this launch.
  assert.equal(campaignLaunchDecision({ ...BASE, preview: previewFor("offer_pitch", 25) }).blockedBy, "preview_required");
  assert.equal(campaignLaunchDecision({ ...BASE, preview: previewFor("winback", 5000) }).blockedBy, "preview_required");
  const allowed = campaignLaunchDecision({ ...BASE, preview: previewFor("winback", 25) });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.blockedBy, null);
});

test("the console cannot offer a launch the environment has not enabled", async () => {
  const { campaignLaunchDecision } = await import("../lib/haptik-console.ts");
  const decision = campaignLaunchDecision({ ...BASE, connected: false, preview: previewFor("winback", 25), connectionReason: "keys missing" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockedBy, "not_connected");
  assert.equal(decision.detail, "keys missing", "the reason is shown, not a button that does nothing");
});

test("an empty audience, a missing campaign and a nonsense limit each block with their own reason", async () => {
  const { campaignLaunchDecision } = await import("../lib/haptik-console.ts");
  assert.equal(campaignLaunchDecision({ ...BASE, campaign: "" }).blockedBy, "no_campaign");
  assert.equal(campaignLaunchDecision({ ...BASE, limit: 0 }).blockedBy, "invalid_limit");
  assert.equal(campaignLaunchDecision({ ...BASE, limit: Number.NaN }).blockedBy, "invalid_limit");
  assert.equal(campaignLaunchDecision({ ...BASE, preview: previewFor("winback", 25, 0) }).blockedBy, "empty_audience");
});

test("quiet hours blocks the launch and says when calling resumes", async () => {
  const { campaignLaunchDecision } = await import("../lib/haptik-console.ts");
  const decision = campaignLaunchDecision({ ...BASE, preview: previewFor("winback", 25), quietHours: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockedBy, "quiet_hours");
  assert.match(decision.detail, /09:00/);
});

test("previewMatchesCampaign is the single predicate the decision and the table share", async () => {
  const { previewMatchesCampaign } = await import("../lib/haptik-console.ts");
  assert.equal(previewMatchesCampaign(null, "winback", 25), false);
  assert.equal(previewMatchesCampaign(previewFor("winback", 25), "winback", 25), true);
  assert.equal(previewMatchesCampaign(previewFor("winback", 25), "winback", 26), false);
  assert.equal(previewMatchesCampaign(previewFor("winback", 25), "offer_pitch", 25), false);
});

test("the WhatsApp setup gaps name every unclosed step and go empty only when the path can complete", async () => {
  const { interaktSetupGaps } = await import("../lib/haptik-console.ts");
  const links = [
    { linkKey: "a", label: "Package link", linkConfigured: false, templateApproved: false },
    { linkKey: "b", label: "Website link", linkConfigured: true, templateApproved: false },
    { linkKey: "c", label: "Renewal link", linkConfigured: true, templateApproved: true },
  ];
  const gaps = interaktSetupGaps({ connected: false, links });
  assert.equal(gaps.length, 3);
  assert.match(gaps[0], /not connected/);
  assert.match(gaps[1], /Package link: no link configured/);
  assert.match(gaps[2], /Website link: no approved WhatsApp template/);
  assert.deepEqual(interaktSetupGaps({ connected: true, links: [links[2]] }), []);
});

// ---------------------------------------------------------------------------
// 2. The Haptik webhook: every action the solution document needs, still key-gated.
// ---------------------------------------------------------------------------
test("the Haptik webhook routes every action the solution document requires", () => {
  const actions = [
    // outbound journeys
    "capture_lead", "capture_callback", "fetch_slots", "request_booking", "record_call_outcome",
    // WhatsApp + package recommendation
    "send_whatsapp", "recommend_package", "package_briefing",
    // inbound agent
    "create_inquiry", "transfer_to_agent", "faq_answer",
  ];
  for (const action of actions) assert.match(haptikRoute, new RegExp(`action==="${action}"`), `missing action: ${action}`);
  // The unsupported-action message is generated from the same list, so it cannot drift from it.
  assert.match(haptikRoute, /Unsupported Haptik action\. Use \$\{ACTIONS\.join\(" \| "\)\}/);
  for (const action of actions) assert.match(haptikRoute, new RegExp(`"${action}"`));
});

test("the new actions stay behind the same fail-closed key check as the original four", () => {
  assert.match(haptikRoute, /HAPTIK_API_KEY/);
  assert.match(haptikRoute, /if\(!key\)throw new Response\(JSON\.stringify\(\{error:"Haptik integration is not connected/);
  assert.match(haptikRoute, /if\(provided!==key\)throw new Response\(JSON\.stringify\(\{error:"Invalid Haptik credentials"\}\),\{status:401\}\)/);
  // assertHaptik runs before the body is even parsed, so no action can be reached without the key.
  const beforeBody = haptikRoute.split("body=await request.json()")[0];
  assert.match(beforeBody, /assertHaptik\(env,request\)/);
  // The bot's identity is fixed by the server, never taken from the request body.
  assert.match(haptikRoute, /const actorId="haptik_voice"/);
  assert.doesNotMatch(haptikRoute, /actorId:String\(body\.actorId/);
});

test("the bot cannot write the rules or the transfer targets it reads", () => {
  // Those writes live only on the staff route, behind staff permissions.
  assert.doesNotMatch(haptikRoute, /upsertGroomingPackageRule|setHaptikTransferTarget|setInteraktLink|setInteraktTemplate/);
  assert.match(configRoute, /requirePermission\(actor,"grooming\.manage"\)/);
  assert.match(configRoute, /requirePermission\(actor,"communications\.manage"\)/);
  assert.match(interaktRoute, /requirePermission\(actor,"communications\.manage"\)/);
});

// ---------------------------------------------------------------------------
// 3. The staff routes: permission-gated, same-origin, and audited.
// ---------------------------------------------------------------------------
test("every staff write is same-origin, permission-gated and audited", () => {
  for (const [name, route] of [["interakt", interaktRoute], ["haptik-config", configRoute]]) {
    assert.match(route, /sameOrigin\(request\)/, `${name} allows a cross-origin write`);
    assert.match(route, /requirePermission\(actor,/, `${name} has an ungated write`);
    assert.match(route, /securityAudit\(db,actor,/, `${name} writes without an audit trail`);
    assert.match(route, /requirePermission\(actor,"marketing\.view"\)/, `${name} has an ungated read`);
  }
});

test("an audited transfer target records only the last four digits of the destination", () => {
  // The audit ledger is a wide-access surface; a staff queue number belongs in the config, not in
  // every audit row.
  assert.match(configRoute, /destinationLast4:data\.destinationLast4/);
  assert.doesNotMatch(configRoute, /destination:data\.destination[^L]/);
});

test("the outbound audience preview returns a count and masked rows, never full numbers", () => {
  assert.match(outboundRoute, /size:audience\.length/);
  assert.match(outboundRoute, /phoneLast4:c\.phone\.replace\(/);
  // The preview must not hand back the raw contact list it just built.
  assert.doesNotMatch(outboundRoute, /audience:await buildOutboundAudience/);
});

test("the outbound route reports the connection and quiet-hours decisions the console renders", () => {
  assert.match(outboundRoute, /connected:haptikOutboundConfigured\(env\)/);
  assert.match(outboundRoute, /quietHours:isQuietHours\(Date\.now\(\)\)/);
});

// ---------------------------------------------------------------------------
// 4. The console page renders decisions from the lib and no full phone numbers.
// ---------------------------------------------------------------------------
test("the console takes its decisions from lib/haptik-console rather than inlining them", () => {
  assert.match(consolePage, /from "\.\.\/\.\.\/\.\.\/lib\/haptik-console"/);
  assert.match(consolePage, /campaignLaunchDecision\(\{/);
  assert.match(consolePage, /previewMatchesCampaign\(preview, campaign, limit\)/);
  assert.match(consolePage, /interaktSetupGaps\(interakt\)/);
  // Editing either field must clear the preview that authorised a launch.
  assert.match(consolePage, /const chooseCampaign = \(code: string\) => \{ setCampaign\(code\); setPreview\(null\); \}/);
  assert.match(consolePage, /const chooseLimit = \(value: number\) => \{ setLimit\(value\); setPreview\(null\); \}/);
  // And the launch button is bound to the decision, not to its own condition.
  assert.match(consolePage, /disabled=\{!decision\.allowed \|\| busy === "launch"\}/);
});

test("the console renders only masked numbers", () => {
  // Every phone rendered on the page comes from a *Last4 field.
  const renderedPhones = consolePage.match(/`••••\$\{[a-zA-Z0-9.]+\}`/g) || [];
  assert.ok(renderedPhones.length >= 3, "the masked-number form is what the page renders");
  for (const rendered of renderedPhones) assert.match(rendered, /Last4/);
  assert.doesNotMatch(consolePage, /row\.phone\}|send\.phone\}|call\.phone\}/, "no raw phone field is rendered");
});

test("the console is reachable from Team instead of only by typing the URL", () => {
  assert.match(teamIndex, /href: "\/team\/haptik"/);
  assert.match(teamIndex, /Haptik voice agents/);
});

// ---------------------------------------------------------------------------
// 5. The Interakt dispatch sweep is wired into the scheduler under a stable name.
// ---------------------------------------------------------------------------
test("the Interakt dispatch sweep runs on the background scheduler", () => {
  assert.match(scheduler, /import\{runInteraktDispatchSweep\}from"\.\/interakt-whatsapp-governance"/);
  assert.match(scheduler, /runInteraktDispatchSweep\(db,\{\}\)/);
  assert.match(scheduler, /"interaktWhatsAppDispatch"/);
  // The task list and the name list are positional; a mismatch would report one sweep's result under
  // another sweep's name.
  const tasks = scheduler.split("Promise.allSettled([")[1].split("]);")[0];
  const names = scheduler.split('const names=[')[1].split("]")[0];
  const taskCount = tasks.split(/\),(?=[a-zA-Z])/).length;
  const nameCount = names.split(",").length;
  assert.equal(taskCount, nameCount, `scheduler tasks (${taskCount}) and names (${nameCount}) are out of step`);
});

test("the Interakt sweep sits after the Haptik outbound sweep, matching its name position", () => {
  const tasks = scheduler.split("Promise.allSettled([")[1].split("]);")[0];
  const names = scheduler.split('const names=[')[1].split("]")[0];
  const taskList = tasks.split(/\),(?=[a-zA-Z])/).map(item => item.trim());
  const nameList = names.split(",").map(item => item.replace(/"/g, "").trim());
  const taskIndex = taskList.findIndex(item => item.startsWith("runInteraktDispatchSweep"));
  const nameIndex = nameList.indexOf("interaktWhatsAppDispatch");
  assert.ok(taskIndex >= 0, "the sweep is in the task list");
  assert.equal(taskIndex, nameIndex, "the sweep's result would be reported under the wrong name");
});

// ---------------------------------------------------------------------------
// 6. The gateway does not fall through to the weakest staff permission.
// ---------------------------------------------------------------------------
test("the new staff routes are registered in the gateway, not left on the dashboard.view default", () => {
  assert.match(gateway, /url\.pathname==="\/api\/interakt"\)\{if\(method==="GET"\)return "marketing\.view";return "communications\.manage";\}/);
  assert.match(gateway, /url\.pathname==="\/api\/haptik-config"\)\{/);
  assert.match(gateway, /"upsert_rule"\?"grooming\.manage":"communications\.manage"/);
  assert.match(gateway, /url\.pathname==="\/api\/haptik-outbound"\)return method==="GET"\?"marketing\.view":"marketing\.manage"/);
  // The bot's own webhook stays key-authenticated rather than permission-gated, as it was before.
  assert.match(gateway, /url\.pathname==="\/api\/haptik"/);
});
