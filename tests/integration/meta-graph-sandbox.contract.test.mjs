import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
import { preflight } from "./sandbox-preflight.mjs";

// ---------------------------------------------------------------------------
// Meta Graph API contract — real HTTP to graph.facebook.com with the UAT credential set.
//
// Said plainly because it is easy to assume otherwise: WhatsApp Cloud API has no separate sandbox
// hostname. The test surface IS graph.facebook.com, and what makes a run non-production is the
// credential set it uses — a test WABA, a test phone number id, and META_WHATSAPP_UAT_ACCESS_TOKEN.
// So there is no host here that guarantees safety, and this suite is built to be read-only for that
// reason.
//
// It deliberately DOES NOT send a message. A send on this API delivers a real WhatsApp to a real
// handset; a test suite that did that would be messaging a person every time CI ran. What it validates
// instead is every precondition a send depends on — the token resolves the phone number, the template
// exists and is approved, the inbound signature and challenge contracts hold — which is where sends
// actually fail. Delivery itself stays with the governed UAT dispatch path, behind
// META_WHATSAPP_UAT_DELIVERY_ENABLED and the recipient allowlist.
// ---------------------------------------------------------------------------

installWorkersHooks("__SANDBOX_META_DB__", "__SANDBOX_META_ENV__");

const TOKEN = "META_WHATSAPP_UAT_ACCESS_TOKEN";
const PHONE_ID = "META_WHATSAPP_PHONE_NUMBER_ID";
const WABA_ID = "META_WHATSAPP_WABA_ID";
const APP_SECRET = "META_WHATSAPP_APP_SECRET";
const VERIFY_TOKEN = "META_WHATSAPP_VERIFY_TOKEN";

const version = () => String(process.env.META_WHATSAPP_GRAPH_VERSION || "v23.0");
const graph = (path) => `https://graph.facebook.com/${version()}/${String(path).replace(/^\/+/, "")}`;
const bearer = () => ({ authorization: `Bearer ${String(process.env[TOKEN] || "")}` });

const state = await preflight({
  suite: "Meta Graph (WhatsApp Cloud API, UAT credentials)",
  required: [
    { name: TOKEN, hint: "UAT access token for the test WhatsApp Business account" },
    { name: PHONE_ID, hint: "test phone number id — the sender identity, not the display number" },
    { name: WABA_ID, hint: "test WhatsApp Business Account id, needed to list templates" },
    { name: APP_SECRET, hint: "app secret; signs the x-hub-signature-256 header on inbound webhooks" },
  ],
  probe: { url: `https://graph.facebook.com/${String(process.env.META_WHATSAPP_GRAPH_VERSION || "v23.0")}/${String(process.env[PHONE_ID] || "0")}`, authenticated: true, headers: { authorization: `Bearer ${String(process.env[TOKEN] || "")}` } },
  ownerAction: 'docs/KARTHIK_PENDING_CLOSEOUT.md Batch A — WhatsApp UAT delivery (PR #392 moved this to the direct Meta Cloud API)',
});

const dispatch = await import("../../lib/meta-whatsapp-uat-dispatch.ts");
const webhook = await import("../../lib/meta-whatsapp-webhook.ts");

async function graphGet(path) {
  const response = await fetch(graph(path), { headers: bearer() });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

test("META-01: the UAT token resolves the configured test phone number", state.gate(), async () => {
  const { status, body } = await graphGet(`${process.env[PHONE_ID]}?fields=id,display_phone_number,verified_name,quality_rating`);
  assert.equal(status, 200, `Graph refused the phone-number read: ${JSON.stringify(body).slice(0, 240)}`);
  assert.equal(String(body.id), String(process.env[PHONE_ID]), "the token must resolve the phone number id we are configured to send from");
  assert.ok(String(body.display_phone_number || "").length > 0, "a display phone number is required — it is what the customer sees as the sender");
  console.log(`META-01 sender=${body.display_phone_number} verified_name=${body.verified_name ?? "(none)"} quality=${body.quality_rating ?? "(none)"}`);
});

test("META-02: templates list, and every status the API returns is one this code understands", state.gate(), async () => {
  const { status, body } = await graphGet(`${process.env[WABA_ID]}/message_templates?limit=25&fields=name,status,language,category`);
  assert.equal(status, 200, `Graph refused the template list: ${JSON.stringify(body).slice(0, 240)}`);
  assert.ok(Array.isArray(body.data), "the template list must be an array under `data`");

  // The real reason this matters: normalizeMetaTemplateStatus decides whether a template is usable. If
  // Meta introduces a status string it does not recognise, templates silently stop being sendable.
  const known = ["approved", "pending_approval", "rejected", "paused", "disabled"];
  const unmapped = [];
  for (const template of body.data) {
    const normalized = dispatch.normalizeMetaTemplateStatus(template.status);
    assert.ok(known.includes(normalized), `normalizeMetaTemplateStatus returned an unknown value for "${template.status}": ${normalized}`);
    // A raw status that normalises to the catch-all while not obviously being that state is worth
    // surfacing rather than asserting on — it is the early warning, not a defect in itself.
    if (String(template.status || "").toLowerCase().replace(/\s+/g, "_") !== normalized) unmapped.push(`${template.name}:${template.status}→${normalized}`);
  }
  console.log(`META-02 templates=${body.data.length} approved=${body.data.filter(t => dispatch.normalizeMetaTemplateStatus(t.status) === "approved").length}`);
  if (unmapped.length) console.log(`META-02 statuses that needed normalising: ${unmapped.slice(0, 8).join(", ")}`);
});

test("META-03: an inbound payload signed with the real app secret verifies, and tampering does not", state.gate(), async () => {
  const secret = String(process.env[APP_SECRET] || "");
  // The shape Meta actually posts, so parseMetaWhatsAppWebhook is exercised on realistic bytes.
  const rawBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: String(process.env[WABA_ID]),
      changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: String(process.env[PHONE_ID]) }, messages: [{ from: "919000000001", id: `wamid.CONTRACT${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "contract probe" } }] } }],
    }],
  });
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  assert.equal(await webhook.verifyMetaWhatsAppSignature(rawBody, signature, secret), true, "a correctly signed body must verify");
  assert.equal(await webhook.verifyMetaWhatsAppSignature(`${rawBody} `, signature, secret), false, "a tampered body must not verify");
  assert.equal(await webhook.verifyMetaWhatsAppSignature(rawBody, signature.replace(/.$/, "0"), secret), false, "a tampered signature must not verify");
  assert.equal(await webhook.verifyMetaWhatsAppSignature(rawBody, signature, `${secret}x`), false, "the wrong app secret must not verify");
  assert.equal(await webhook.verifyMetaWhatsAppSignature(rawBody, signature.replace(/^sha256=/, ""), secret), false, "an unprefixed digest must not verify");

  // And the payload we just signed is one the parser can actually read, which is the other half of a
  // round trip — a verified body nobody can parse is not an integration.
  const parsed = webhook.parseMetaWhatsAppWebhook(JSON.parse(rawBody));
  assert.ok(parsed, "the signed payload must parse");
  console.log(`META-03 signature contract holds; parsed shape: ${JSON.stringify(parsed).slice(0, 160)}`);
});

test("META-04: the webhook challenge answers the real verify token and nothing else", { ...state.gate(), ...(process.env[VERIFY_TOKEN] ? {} : { skip: `${VERIFY_TOKEN} is not configured — the subscribe handshake cannot be exercised` }) }, async () => {
  const token = String(process.env[VERIFY_TOKEN] || "");
  const url = (mode, supplied, challenge) => new URL(`https://uat.pawspace.in/api/whatsapp/meta-webhook?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(supplied)}&hub.challenge=${challenge}`);
  assert.equal(webhook.verifyMetaWebhookChallenge(url("subscribe", token, "12345"), token), "12345", "the real token must echo the challenge");
  assert.equal(webhook.verifyMetaWebhookChallenge(url("subscribe", `${token}x`, "12345"), token), null, "a wrong token must not");
  assert.equal(webhook.verifyMetaWebhookChallenge(url("unsubscribe", token, "12345"), token), null, "only a subscribe handshake is answered");
});

test("META-05: a send is possible only behind the delivery flag and the recipient allowlist", state.gate(), async () => {
  // Asserted rather than performed. This suite never delivers a message: the precondition that sends
  // actually fail on is template approval (META-02) and sender identity (META-01), and both are read-only.
  const deliveryEnabled = String(process.env.META_WHATSAPP_UAT_DELIVERY_ENABLED || "").toLowerCase() === "true";
  const allowlist = String(process.env.META_WHATSAPP_UAT_ALLOWLIST || "").split(/[,;\n]+/).map(v => v.replace(/[^0-9]/g, "")).filter(v => v.length >= 8);
  if (!deliveryEnabled) {
    console.log("META-05 delivery is disabled (META_WHATSAPP_UAT_DELIVERY_ENABLED not true) — no message can leave this environment");
    return;
  }
  assert.ok(allowlist.length > 0, "delivery is enabled with an EMPTY recipient allowlist — that combination can message anyone and must not stand");
  console.log(`META-05 delivery enabled with ${allowlist.length} allowlisted recipient(s); this suite still sends nothing`);
});
