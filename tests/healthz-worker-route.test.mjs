import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");

test("Cloudflare Worker exposes a dependency-free GET /healthz liveness probe", () => {
  const health = worker.indexOf('url.pathname==="/healthz"&&request.method==="GET"');
  const apiGateway = worker.indexOf('url.pathname.startsWith("/api/")');
  assert.ok(health >= 0, "Worker must register GET /healthz");
  assert.ok(apiGateway > health, "health probe must terminate before API auth/database work");
  assert.match(worker, /Response\.json\(\{status:"ok"\}/);
  assert.match(worker, /"cache-control":"no-store"/);
});
