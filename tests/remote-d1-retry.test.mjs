import test from "node:test";
import assert from "node:assert/strict";
import { classifyRemoteD1Retry } from "../scripts/schema/remote-d1-retry.mjs";

test("remote D1 reset remains retryable", () => {
  assert.deepEqual(classifyRemoteD1Retry("error: D1_RESET_DO"), { retryable: true, reason: "D1_RESET_DO" });
});

test("Wrangler import-state race is retryable", () => {
  const detail = "Processed 6 queries.\nERROR Not currently importing anything.";
  assert.deepEqual(classifyRemoteD1Retry(detail), { retryable: true, reason: "D1 import-state race" });
});

test("SQL and schema errors are not retried", () => {
  assert.deepEqual(classifyRemoteD1Retry("SQLITE_ERROR: no such column: missing"), { retryable: false, reason: "non-transient D1 error" });
});
