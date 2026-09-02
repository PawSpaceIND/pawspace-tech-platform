import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__INTERAKT_DB__", "__INTERAKT_ENV__");
const interakt = await import("../lib/interakt-whatsapp.ts");

const env = { INTERAKT_API_KEY: "test-key", INTERAKT_WEBHOOK_SECRET: "examplekey" };

test("Interakt webhook HMAC validates the documented sha256 signature over the raw payload", async () => {
  const rawBody = '{"foo":1,"bar":2}';
  const documented = "sha256=b84783d10ede5bd6ed771e8b16fbe5a7093340159d6e49ec4248350b6ec2c7b4";
  assert.equal((await interakt.validateInteraktWebhookSignature(env, rawBody, new Headers({ "Interakt-Signature": documented }))).verified, true);
  assert.equal((await interakt.validateInteraktWebhookSignature(env, rawBody, new Headers({ "Interakt-Signature": `sha256=${"0".repeat(64)}` }))).verified, false);
  assert.equal((await interakt.validateInteraktWebhookSignature(env, rawBody, new Headers())).verified, false);
});

test("Interakt adapter fails closed when API key is missing", () => {
  assert.equal(interakt.interaktConfig({}), null);
});

test("Interakt production boundary requires exact consent, approved templates and canonical ownership", () => {
  const source = readFileSync(new URL("../lib/interakt-whatsapp.ts", import.meta.url), "utf8");
  assert.match(source, /Number\(row\.whatsapp_consent\) === 1 && row\.opt_out != null && Number\(row\.opt_out\) === 0/);
  assert.match(source, /SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=\?/);
  assert.match(source, /text\(registry\.status\) === "approved"/);
  assert.match(source, /interakt_template_not_verified/);
});

test("communication outbox delegates adapterName=interakt to the hardened Interakt dispatcher", () => {
  const source = readFileSync(new URL("../lib/communication-provider-boundary.ts", import.meta.url), "utf8");
  assert.match(source, /dispatchInteraktOutboxMessage/);
  assert.match(source, /adapterName[^\n]+interakt/);
});

test("production config keeps Interakt credentials out of plaintext wrangler vars", () => {
  const source = readFileSync(new URL("../scripts/prod-config.mjs", import.meta.url), "utf8");
  for (const name of ["INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET"]) assert.match(source, new RegExp(name));
  assert.match(source, /must be Cloudflare Worker secrets/);
});
