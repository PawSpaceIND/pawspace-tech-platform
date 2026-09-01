import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("the primary Worker exposes a cache-safe liveness endpoint before API authorization", () => {
  const health = source.indexOf('url.pathname==="/healthz"');
  const api = source.indexOf('url.pathname.startsWith("/api/")');
  assert.ok(health >= 0 && api > health, "liveness must not depend on application auth or database state");
  assert.match(source, /status:"ok",service:"pawspace-tech-platform"/);
  assert.match(source, /"cache-control":"no-store"/);
  assert.match(source, /"x-content-type-options":"nosniff"/);
});

test("scheduled-worker failures identify the failed job without logging provider or database messages", () => {
  const scheduled = source.slice(source.indexOf("async scheduled("));
  assert.doesNotMatch(scheduled, /\.reason\.message|String\([^)]*\.reason\)|errors\.push\(\.\.\.scheduler\.value\.errors\)/);
  for (const job of ["reservation_cleanup", "background_scheduler", "whatsapp_recovery", "razorpay_settlement_reconciliation", "subscription_maintenance"])
    assert.match(scheduled, new RegExp(job));
});
