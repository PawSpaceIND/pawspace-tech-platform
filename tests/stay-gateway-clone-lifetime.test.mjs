import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the stay gateway keeps the booking body readable when authorization clones are collected", () => {
  // Run native Request streams under real GC. This reproduced the CI failure on
  // Node 22.16 before the harness used the existing request-scoped clone adapter.
  const result = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", fileURLToPath(new URL("./helpers/stay-request-clone-gc-probe.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, NODE_ENV: "test", APP_ENV: "staging", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on" },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
