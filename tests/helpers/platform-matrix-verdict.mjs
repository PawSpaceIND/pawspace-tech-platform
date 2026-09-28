import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(new URL("../fixtures/platform-required-probes.json", import.meta.url), "utf8"));
assert.equal(manifest.probes.length, 81, "Required probe manifest must preserve the reviewed inventory");
assert.ok(manifest.probes.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((value) => typeof value === "string" && value.trim())));
const required = Object.freeze(manifest.probes.map((pair) => JSON.stringify(pair)).sort());
assert.equal(new Set(required).size, required.length, "Required probe manifest contains duplicate identities");

// The real E2E terminal test and its fault tests execute this same assertion.
// Expected identities are independently reviewed, not inferred from the observed run.
export function assertPlatformMatrix(results) {
  assert.ok(Array.isArray(results) && results.length > 0, "Required E2E probe evidence is missing");
  assert.ok(results.every((row) => row && typeof row === "object" && typeof row.module === "string" && typeof row.area === "string"), "Required E2E probe evidence is malformed");
  const blockers = results.filter((row) => row.status !== "PASS");
  assert.equal(blockers.length, 0, "Required E2E probes did not pass:\n" + blockers.map((row) => `${row.status} ${row.module}/${row.area}: ${row.detail}`).join("\n"));
  assert.equal(results.length, required.length, "Required E2E probe inventory changed; review coverage explicitly");
  const identities = results.map((row) => JSON.stringify([row.module, row.area]));
  assert.equal(new Set(identities).size, identities.length, "Required E2E probe identities must be unique");
  assert.deepEqual(identities.sort(), required, "Required E2E probe identities do not match the reviewed manifest");
}
