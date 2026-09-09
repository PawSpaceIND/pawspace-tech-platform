import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
