import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readBoundedRequestText, VoiceFetchRefused } from "../lib/voice-safe-fetch.ts";

const files = [
  "app/api/whatsapp/meta-webhook/route.ts",
  "app/api/whatsapp-uat-webhook/route.ts",
  "app/api/email-provider-webhook/route.ts",
  "app/api/communication-provider-callback/route.ts",
];

for (const path of files) {
  test(`${path} bounds the body with readBoundedRequestText before trust work`, () => {
    const src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(src, /readBoundedRequestText/);
    assert.match(src, /VoiceFetchRefused/);
    assert.match(src, /413/);
    assert.doesNotMatch(src, /const raw(?:Body)?=await request\.text\(\)/);
  });
}

test("readBoundedRequestText refuses an oversized body before full buffer", async () => {
  const body = "x".repeat(2000);
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    body,
    headers: { "content-type": "text/plain", "content-length": String(body.length) },
  });
  await assert.rejects(
    () => readBoundedRequestText(request, 100),
    (error) => error instanceof VoiceFetchRefused,
  );
});

test("readBoundedRequestText accepts a small body", async () => {
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    body: "{\"ok\":true}",
    headers: { "content-type": "application/json" },
  });
  const text = await readBoundedRequestText(request, 10_000);
  assert.equal(text, '{"ok":true}');
});
