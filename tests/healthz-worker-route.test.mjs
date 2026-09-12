import assert from "node:assert/strict";
import test from "node:test";
import "tsx/esm";

const { handleEdgeHealth } = await import("../lib/edge-health.ts");

test("GET /healthz returns dependency-free non-cacheable liveness response", async () => {
  const response = handleEdgeHealth(new Request("https://edge.test/healthz"));
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("health handler declines non-GET and non-health routes", () => {
  assert.equal(handleEdgeHealth(new Request("https://edge.test/healthz", { method: "POST" })), null);
  assert.equal(handleEdgeHealth(new Request("https://edge.test/api/healthz")), null);
});
