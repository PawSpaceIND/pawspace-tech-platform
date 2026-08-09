import assert from "node:assert/strict";
import test from "node:test";

const reviewRoutes = [
  "/business",
  "/prelaunch",
  "/team/revenue-mission",
  "/team/cases",
  "/team/alerts",
  "/team/analytics",
  "/team/finance/partners",
  "/team/ai",
  "/team/ai/configuration",
  "/team/ai/handoff",
  "/team/ai/analytics",
];

test("renders every founder human-review route from the exact candidate", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("founder-review-routes", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  for (const path of reviewRoutes) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200, `${path} must render from this candidate`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i, path);
  }
});
