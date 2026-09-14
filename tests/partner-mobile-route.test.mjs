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

  assert.match(html, /Checking your partner session/i);
  assert.doesNotMatch(html, /NEXT ASSIGNMENT/);

});

test("Partner Mobile uses governed provider identity and GPS APIs", async () => {
  const source = await readFile(
    new URL("../app/partner-mobile/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /export \{default\} from "\.\.\/partner-app\/page"/);
  const shared=await readFile(new URL("../app/partner-app/page.tsx",import.meta.url),"utf8");
  assert.match(shared,/useStatusQueue/);assert.match(shared,/useDutyTracking/);
  assert.match(shared,/\/api\/identity-session/);assert.match(shared,/\/api\/partner-jobs/);
});
