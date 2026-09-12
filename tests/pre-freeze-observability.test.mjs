import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root=new URL("..",import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),"utf8");

test("Cloudflare observability is enabled with invocation logs and traces",()=>{
  const wrangler=read("wrangler.toml");
  assert.match(wrangler,/\[observability\]/);
  assert.match(wrangler,/invocation_logs = true/);
  assert.match(wrangler,/\[observability\.traces\]/);
});

test("Sentry global worker capture remains PII-safe",()=>{
  const worker=read("worker/index.ts");
  assert.match(worker,/@sentry\/cloudflare/);
  assert.match(worker,/Sentry\.withSentry/);
  assert.match(worker,/sendDefaultPii:false/);
  assert.match(worker,/SENTRY_DSN/);
  assert.match(worker,/controlled_staging_sentry_self_test/);
});

test("observability changes never enter src or drizzle",()=>{
  const verifier=read("scripts/observability/verify-observability-config.mjs");
  assert.doesNotMatch(verifier,/src\//);
  assert.doesNotMatch(verifier,/drizzle\//);
});
