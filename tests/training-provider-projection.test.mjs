import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projection = readFileSync(new URL("../lib/training-provider-projection.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/training-sessions/route.ts", import.meta.url), "utf8");

test("training-sessions GET projects sessions through training-provider-projection", () => {
  assert.match(route, /from"\.\.\/\.\.\/\.\.\/lib\/training-provider-projection"/);
  assert.match(route, /projectTrainerSession/);
  assert.match(route, /maskName/);
});

test("training provider projection never returns raw actor_id or detail_json", () => {
  assert.match(projection, /actorId:\s*"provider_or_system"/);
  assert.match(projection, /SAFE_EVENT_DETAIL_KEYS/);
  assert.match(projection, /sanitizeTrainingEventDetail/);
  assert.match(projection, /projectTrainingSessionEvent/);
  assert.doesNotMatch(projection, /detail_json:\s*row/);
});

test("training provider projection allowlists operational event keys only", () => {
  assert.match(projection, /"from"/);
  assert.match(projection, /"to"/);
  assert.match(projection, /"consumedExactlyOnce"/);
  assert.match(projection, /"evidenceRefs"/);
  assert.match(projection, /looksLikePii/);
});

test("projectTrainerSession drops unbounded free-text and contact-shaped fields from requirements", () => {
  assert.match(projection, /looksLikePii\(x\)/);
  assert.match(projection, /customer_name/);
  assert.match(projection, /events/);
});
