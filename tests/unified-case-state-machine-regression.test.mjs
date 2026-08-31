import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cases = await readFile(new URL("../lib/unified-case-center.ts", import.meta.url), "utf8");
const scheduler = await readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");

test("case actions define legal source states and terminal reopen rules", () => {
  assert.match(cases, /ACTION_STATES/);
  assert.match(cases, /close:\["resolved"\]/);
  assert.match(cases, /reopen:\["resolved","closed"\]/);
  assert.match(cases, /Case cannot \$\{input\.action\} from \$\{current\}/);
});

test("case mutation is compare-and-set and no-op/concurrent changes do not emit success", () => {
  assert.match(cases, /WHERE id=\? AND status=\?/);
  assert.match(cases, /meta\?\.changes\|\|0\)!==1/);
  assert.match(cases, /Case changed concurrently; reload before retrying/);
});

test("SLA event helper reports whether the idempotent event was newly inserted", () => {
  assert.match(cases, /return Number\(result\.meta\?\.changes\|\|0\)===1/);
  assert.match(cases, /if\(await event\(db,id,"first_response_breached"/);
  assert.match(cases, /if\(await event\(db,id,"resolution_breached"/);
  assert.match(cases, /if\(await event\(db,id,"manager_escalation_due"/);
});

test("unified case escalation is part of the five-minute scheduler exactly once", () => {
  assert.match(scheduler, /import\{runUnifiedCaseEscalations\}from"\.\/unified-case-center"/);
  const calls = scheduler.match(/runUnifiedCaseEscalations\(db,\{actorId,asOf\}\)/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(scheduler, /"unifiedCaseEscalations"/);
});
