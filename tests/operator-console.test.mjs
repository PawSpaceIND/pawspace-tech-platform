import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const consoleSource = await read("../app/admin/operator-console/operator-console.tsx");
const pageSource = await read("../app/admin/operator-console/page.tsx");

// These route files are supplied by the real repository when this test runs there. The candidate
// harness only validates the new UI source locally; repository CI also evaluates these assertions.
const haptikRoute = await read("../app/api/haptik-outbound/route.ts").catch(() => "");
const communicationsRoute = await read("../app/api/communications/route.ts").catch(() => "");
const outcomesRoute = await read("../app/api/bot-call-outcomes/route.ts").catch(() => "");

test("operator console is a dedicated admin route with a client boundary", () => {
  assert.match(pageSource, /OperatorConsole/);
  assert.match(consoleSource, /^"use client";/);
  assert.match(consoleSource, /href="\/admin"/);
});

test("operator console reads governed campaign, call, outbox and bot-claim APIs", () => {
  assert.match(consoleSource, /api<CampaignOverview>\("\/api\/haptik-outbound"\)/);
  assert.match(consoleSource, /\/api\/haptik-outbound\?mode=calls&limit=200/);
  assert.match(consoleSource, /api<CommunicationsData>\("\/api\/communications"\)/);
  assert.match(consoleSource, /\/api\/bot-call-outcomes\?scope=pending_claims&limit=100/);
  assert.match(consoleSource, /credentials: "same-origin"/);
  assert.match(consoleSource, /cache: "no-store"/);
});

test("campaign launches reuse the existing guarded POST and never request a quiet-hours override", () => {
  assert.match(consoleSource, /method: "POST"/);
  assert.match(consoleSource, /JSON\.stringify\(\{ campaign, limit \}\)/);
  assert.doesNotMatch(consoleSource, /force\s*:\s*true/);
  assert.match(consoleSource, /marketing\.manage/);
});

test("claim review posts only the existing reconcile contract", () => {
  assert.match(consoleSource, /action: "reconcile"/);
  assert.match(consoleSource, /dispositionId: claim\.dispositionId/);
  assert.match(consoleSource, /outcome, note/);
  assert.match(consoleSource, /customers\.manage/);
  assert.match(consoleSource, /note\.length < 5/);
});

test("repository routes keep the existing permission and same-origin gates", { skip: !haptikRoute || !communicationsRoute || !outcomesRoute }, () => {
  assert.match(haptikRoute, /requirePermission\(actor,"marketing\.view"\)/);
  assert.match(haptikRoute, /requirePermission\(actor,"marketing\.manage"\)/);
  assert.match(haptikRoute, /sameOrigin\(request\)/);
  assert.match(communicationsRoute, /requirePermission\(actor,"communications\.manage"\)/);
  assert.match(outcomesRoute, /authorize\(request,"customers\.view"\)/);
  assert.match(outcomesRoute, /authorize\(request,"customers\.manage"\)/);
  assert.match(outcomesRoute, /sameOrigin\(request\)/);
});
