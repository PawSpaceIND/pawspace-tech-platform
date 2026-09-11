/*
 * Day-31 wave 11: verifying a WhatsApp template's status against Meta.
 *
 * lib/whatsapp-production-runtime.ts (21KB) had no test importing it. This function decides
 * whether a template is APPROVED, and the platform only sends business-initiated messages on
 * approved templates. Getting it wrong in the permissive direction is not a bug that shows up in
 * our logs - it shows up as Meta restricting the WABA, which takes every customer conversation
 * down with it and is slow to undo.
 *
 * So the property throughout is one-directional: a template becomes 'approved' ONLY when Meta
 * says APPROVED about that exact template, and every other outcome - an unrecognised status, a
 * missing template, an HTTP error, a redirect - must land somewhere that is not approved.
 *
 * Meta is stubbed through the function's own `fetcher` parameter. No network, and the outbound
 * request is inspected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_WATPL_DB__", "__D31X_WATPL_ENV__");

const TEMPLATE = "booking_reminder_v2";
const ACTOR = "ops@pawspace.in";
// UAT mode reads the _UAT-suffixed credentials; the unsuffixed ones are the live set and are
// deliberately absent here so nothing in this suite could reach a production WABA.
const ENV = {
  PAWSPACE_COMMUNICATION_ENV: "uat",
  META_WHATSAPP_UAT_ACCESS_TOKEN: "uat-fixture-meta-token",
  META_WHATSAPP_WABA_ID_UAT: "111222333",
  META_WHATSAPP_PHONE_NUMBER_ID_UAT: "444555666",
  META_ADS_API_VERSION: "v21.0",
};

async function seedTemplates(env = ENV) {
  const { sqlite, db } = world("__D31X_WATPL_DB__", "__D31X_WATPL_ENV__", env);
  const runtime = await import("../lib/whatsapp-production-runtime.ts");
  const { ensureWhatsAppTemplateLifecycle } = await import("../lib/whatsapp-template-lifecycle.ts");
  await ensureWhatsAppTemplateLifecycle(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR IGNORE INTO whatsapp_template_lifecycle (template_key,display_name,body,meta_reconciliation_status,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'submitted',?,?,?,?)")
    .run(TEMPLATE, "Booking reminder", "Hi {{1}}, your groom is on {{2}}.", ACTOR, now, ACTOR, now);
  return { sqlite, db, runtime };
}

/** Stub Meta's Graph API and keep every request made to it. */
function stubMeta(handler) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: String(url), init }); return handler(calls.length); };
  return { calls, fetcher };
}
const graphResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const template = (status) => ({ data: [{ id: "tpl_123", name: TEMPLATE, status, category: "UTILITY", language: "en" }] });

const lifecycleStatus = (sqlite) =>
  sqlite.prepare("SELECT meta_reconciliation_status FROM whatsapp_template_lifecycle WHERE template_key=?").get(TEMPLATE)?.meta_reconciliation_status;

test("a template Meta calls APPROVED is recorded as approved", async () => {
  const { sqlite, db, runtime } = await seedTemplates();
  const meta = stubMeta(() => graphResponse(template("APPROVED")));
  const result = await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher });

  assert.equal(result.status, "approved");
  assert.equal(result.remoteStatus, "APPROVED", "the raw Meta status must be kept as evidence");
  assert.equal(result.externalMetaMutation, false, "verification reads Meta, it never changes anything there");
  assert.equal(lifecycleStatus(sqlite), "approved");
});

test("NOTHING Meta says other than APPROVED results in approved", async () => {
  /*
   * The one-directional property. Every other status Meta can return - including ones this
   * platform has never seen, which is the case a future Meta change will actually produce - must
   * land somewhere that is not approved.
   */
  for (const remote of [
    "REJECTED", "PAUSED", "DISABLED", "PENDING", "IN_APPEAL", "PENDING_DELETION",
    "LIMIT_EXCEEDED", "", "approved_ish", "SOMETHING_META_ADDS_IN_2027",
  ]) {
    const { sqlite, db, runtime } = await seedTemplates();
    const meta = stubMeta(() => graphResponse(template(remote)));
    const result = await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher });
    assert.notEqual(result.status, "approved", `Meta said "${remote}" - that is not approval`);
    assert.notEqual(lifecycleStatus(sqlite), "approved");
  }
});

test("a lower-case 'approved' from Meta is still approval, and is normalised", async () => {
  const { db, runtime } = await seedTemplates();
  const meta = stubMeta(() => graphResponse(template("approved")));
  const result = await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher });
  assert.equal(result.status, "approved", "Meta's own casing must not decide the outcome");
});

test("a template Meta does not have is refused, never assumed", async () => {
  const { sqlite, db, runtime } = await seedTemplates();
  for (const payload of [
    { data: [] },
    {},
    { data: [{ id: "tpl_other", name: "some_other_template", status: "APPROVED" }] },
  ]) {
    const meta = stubMeta(() => graphResponse(payload));
    await assert.rejects(
      () => runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher }),
      (thrown) => { assert.equal(thrown.status, 404); return true; },
      "a template absent from the connected WABA must not inherit another template's approval",
    );
  }
  assert.notEqual(lifecycleStatus(sqlite), "approved");
});

test("an error from Meta is an error, not an approval", async () => {
  const { sqlite, db, runtime } = await seedTemplates();
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const meta = stubMeta(() => graphResponse({ error: { message: "upstream" } }, status));
    await assert.rejects(
      () => runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher }),
      /HTTP/,
      `an HTTP ${status} must not be read as a status`,
    );
  }
  assert.notEqual(lifecycleStatus(sqlite), "approved");
});

test("verification is refused, and no call made, without Meta credentials", async () => {
  for (const missing of [
    { META_WHATSAPP_UAT_ACCESS_TOKEN: "" },
    { META_WHATSAPP_WABA_ID_UAT: "" },
    { META_WHATSAPP_UAT_ACCESS_TOKEN: "", META_WHATSAPP_WABA_ID_UAT: "" },
  ]) {
    const env = { ...ENV, ...missing };
    const { db, runtime } = await seedTemplates(env);
    const meta = stubMeta(() => graphResponse(template("APPROVED")));
    await assert.rejects(
      () => runtime.verifyMetaTemplateStatus(db, env, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher }),
      (thrown) => { assert.equal(thrown.status, 503); return true; },
    );
    assert.equal(meta.calls.length, 0, "an unconfigured verification must not reach out at all");
  }
});

test("the access token travels in a header and never in the URL", async () => {
  const { db, runtime } = await seedTemplates();
  const meta = stubMeta(() => graphResponse(template("APPROVED")));
  await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher });

  const [call] = meta.calls;
  assert.equal(call.init.headers.authorization, "Bearer uat-fixture-meta-token");
  assert.doesNotMatch(call.url, /uat-fixture-meta-token/, "a token in a URL ends up in access logs");
  assert.match(call.url, new RegExp(`name=${TEMPLATE}`), "the query must name the template being verified");
  assert.equal(call.init.redirect, "error",
    "a redirect must not be followed - it would carry the bearer token to whatever host Meta's response named");
});

test("a template key is required and is matched case-insensitively", async () => {
  const { db, runtime } = await seedTemplates();
  const meta = stubMeta(() => graphResponse(template("APPROVED")));
  await assert.rejects(
    () => runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: "  ", actorId: ACTOR, fetcher: meta.fetcher }),
    (thrown) => { assert.equal(thrown.status, 400); return true; },
  );

  const upper = stubMeta(() => graphResponse({ data: [{ id: "t", name: TEMPLATE.toUpperCase(), status: "APPROVED", language: "en", category: "UTILITY" }] }));
  const result = await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: upper.fetcher });
  assert.equal(result.status, "approved", "Meta's casing of the template name must not lose the match");
});

test("every verification leaves an audit event naming what Meta actually said", async () => {
  const { sqlite, db, runtime } = await seedTemplates();
  const meta = stubMeta(() => graphResponse(template("REJECTED")));
  await runtime.verifyMetaTemplateStatus(db, ENV, { templateKey: TEMPLATE, actorId: ACTOR, fetcher: meta.fetcher });

  const event = sqlite.prepare("SELECT event_type,to_status,actor_email,detail_json FROM whatsapp_template_lifecycle_events WHERE template_key=? ORDER BY created_at DESC LIMIT 1").get(TEMPLATE);
  assert.equal(event.event_type, "meta_status_verified");
  assert.equal(event.to_status, "rejected");
  assert.equal(event.actor_email, ACTOR);
  assert.match(event.detail_json, /"remoteStatus":"REJECTED"/,
    "the raw remote status must be recorded, not just our interpretation of it");
});
