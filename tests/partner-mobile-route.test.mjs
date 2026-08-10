import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("renders the Partner Mobile field app route", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("partner-mobile", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/partner-mobile", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /PawSpace Partner/i);
  assert.match(html, /GPS & ETA/i);
  assert.match(html, /Track journey/i);
});

test("Partner Mobile uses governed provider identity and GPS APIs", async () => {
  const source = await readFile(
    new URL("../app/partner-mobile/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /\/api\/identity-session/);
  assert.match(source, /\/api\/partner-grooming-jobs/);
  assert.match(source, /\/api\/grooming-route/);
  assert.match(source, /navigator\.geolocation/);
  assert.match(source, /Use my GPS & calculate ETA/);
  assert.match(source, /Continuous background tracking is not enabled in UAT/);
});
