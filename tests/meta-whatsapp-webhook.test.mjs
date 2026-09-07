/*
 * Meta WhatsApp inbound webhook: signature verification, executed.
 *
 * This suite used to assert its properties by regex-matching lib/meta-whatsapp-webhook.ts - that
 * the strings `crypto.subtle.importKey("raw"`, `crypto.subtle.sign("HMAC",...)` and `sha256=`
 * APPEARED in the source. This endpoint is a PUBLIC inbound webhook: the HMAC is the only thing
 * standing between Meta's traffic and anyone on the internet posting a fabricated message into the
 * customer's conversation history. "The file mentions HMAC" is not a standard for that.
 *
 * verifyMetaWhatsAppSignature is a pure async function, so there was never a reason not to run it.
 * These tests compute real HMACs and check what the verifier accepts and rejects.
 *
 * The source-ABSENCE assertions at the bottom are kept deliberately. `autoSend:true` must never
 * appear in this module - a negative over the whole file that execution cannot establish, because
 * proving it would mean driving every branch. Absence is legitimately a source property; presence
 * of an identifier is not. That distinction is the reason this file keeps both kinds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

/* lib/meta-whatsapp-webhook.ts imports its siblings without a .ts extension, which bare node cannot
 * resolve. installWorkersHooks registers the repo's resolver (and the cloudflare:workers shim the
 * dependency graph pulls in). No database is used by these tests - the verifier is pure - but the
 * globals must exist for the hook to install. */
installWorkersHooks("__META_SIG_DB__", "__META_SIG_ENV__");
globalThis.__META_SIG_DB__ = null;
globalThis.__META_SIG_ENV__ = {};

const { verifyMetaWhatsAppSignature, verifyMetaWebhookChallenge } =
  await import("../lib/meta-whatsapp-webhook.ts");

const SECRET = "meta-app-secret-for-tests-0123456789";
const BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA-1", changes: [{ field: "messages", value: { messages: [{ from: "919876500011", id: "wamid.TEST", type: "text", text: { body: "hello" } }] } }] }],
});
const sign = (body, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("META-SIG-1: a correctly signed body is accepted", async () => {
  assert.equal(await verifyMetaWhatsAppSignature(BODY, sign(BODY), SECRET), true,
    "a genuine Meta signature was rejected - every assertion below would pass vacuously");
});

test("META-SIG-2: a tampered body with a valid-looking signature is rejected", async () => {
  /* The attack this guard exists for: replay a real signature against edited content. The signature
   * is computed over the ORIGINAL body and the body is then changed. */
  const good = sign(BODY);
  const tampered = BODY.replace('"hello"', '"transfer my booking to another provider"');
  assert.notEqual(tampered, BODY, "the tamper did not change the body");
  assert.equal(await verifyMetaWhatsAppSignature(tampered, good, SECRET), false,
    "FORGERY ACCEPTED: an edited body passed with a signature computed over the original");
});

test("META-SIG-3: a signature made with the wrong secret is rejected", async () => {
  assert.equal(await verifyMetaWhatsAppSignature(BODY, sign(BODY, "not-the-app-secret-aaaaaaaaaaaaaaa"), SECRET), false,
    "a signature from an unknown secret was accepted");
});

test("META-SIG-4: one flipped hex character is rejected", async () => {
  const good = sign(BODY);
  const flipped = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
  assert.equal(flipped.length, good.length);
  assert.equal(await verifyMetaWhatsAppSignature(BODY, flipped, SECRET), false,
    "a near-miss signature was accepted - the comparison is not whole-digest");
});

test("META-SIG-5: missing, malformed and wrong-length headers are all rejected", async () => {
  const good = sign(BODY);
  for (const [label, header] of [
    ["null", null],
    ["empty", ""],
    ["no sha256= prefix", createHmac("sha256", SECRET).update(BODY).digest("hex")],
    ["wrong algorithm prefix", good.replace("sha256=", "sha1=")],
    ["truncated", good.slice(0, 40)],
    ["over-long", good + "00"],
    ["not hex", "sha256=" + "z".repeat(64)],
  ]) {
    assert.equal(await verifyMetaWhatsAppSignature(BODY, header, SECRET), false,
      `a ${label} signature header was accepted`);
  }
});

test("META-SIG-6: an empty app secret refuses everything - fail closed, not fail open", async () => {
  /* An unconfigured environment must reject, never accept. A verifier that returns true when the
   * secret is missing turns a misconfiguration into an open webhook. */
  assert.equal(await verifyMetaWhatsAppSignature(BODY, sign(BODY, ""), ""), false,
    "an unconfigured app secret accepted a signature");
  assert.equal(await verifyMetaWhatsAppSignature(BODY, sign(BODY), ""), false);
});

test("META-SIG-7: the case of the incoming header does not change the verdict", async () => {
  const good = sign(BODY);
  assert.equal(await verifyMetaWhatsAppSignature(BODY, good.toUpperCase(), SECRET), true,
    "an upper-case hex digest from a provider was rejected");
});

test("META-CHALLENGE-1: the subscribe handshake only echoes on an exact token match", () => {
  const url = (params) => new URL(`https://api.pawspace.test/api/whatsapp/webhook?${new URLSearchParams(params)}`);
  const TOKEN = "verify-token-abc";
  assert.equal(verifyMetaWebhookChallenge(url({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "12345" }), TOKEN), "12345");
  assert.equal(verifyMetaWebhookChallenge(url({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" }), TOKEN), null,
    "a wrong verify token completed the handshake");
  assert.equal(verifyMetaWebhookChallenge(url({ "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "12345" }), TOKEN), null);
  assert.equal(verifyMetaWebhookChallenge(url({ "hub.mode": "subscribe", "hub.verify_token": TOKEN }), TOKEN), null,
    "a handshake with no challenge returned a value");
  assert.equal(verifyMetaWebhookChallenge(url({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "12345" }), ""), null,
    "an unconfigured verify token completed the handshake");
});

/* ---------------------------------------------------------------------------
 * Source ABSENCE assertions, kept on purpose.
 *
 * These are negatives over the whole module. Execution cannot establish them without driving every
 * branch, and a single missed branch would make an executed version weaker than this one. Presence
 * of an identifier is a bad assertion; absence of a dangerous one is a good one.
 * ------------------------------------------------------------------------- */
const source = await readFile(new URL("../lib/meta-whatsapp-webhook.ts", import.meta.url), "utf8");
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("META-ABSENCE-1: this module never auto-sends", () => {
  assert.doesNotMatch(stripped, /autoSend\s*:\s*true/,
    "an auto-send path appeared in the inbound webhook - AI drafts must stay approval-gated");
});

test("META-ABSENCE-2: external delivery stays explicitly fail-closed", () => {
  const markers = stripped.match(/externalDelivery\s*:\s*false/g) || [];
  assert.ok(markers.length >= 6,
    `expected at least 6 explicit externalDelivery:false markers, found ${markers.length}`);
  assert.doesNotMatch(stripped, /externalDelivery\s*:\s*true/, "external delivery was enabled");
});
