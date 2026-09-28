import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/platform-matrix-gate-child.mjs", import.meta.url));
const cases = ["none", "settlement", "analytics", "GAP", "HARNESS", "UNKNOWN", "empty", "missing", "duplicate"];
for (const fault of cases) {
  test(`actual platform matrix release gate: ${fault}`, { timeout: 65000 }, () => {
    const env = { ...process.env, PAWSPACE_TEST_MATRIX_FAULT: fault,
      PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_PAYMENT_ENV: "sandbox",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
      APP_ENV: "staging", NODE_ENV: "test", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on",
      PAWSPACE_VOICE_TRANSPORT: "local_simulator_non_production" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test",
      "--test-reporter=tap", fixture], { cwd: root, env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "a killed runner is not a valid red-gate result");
    const output = result.stdout + result.stderr;
    if (fault === "none") {
      assert.equal(result.status, 0, output);
      assert.match(output, /ok \d+ - E2E-999 result matrix/);
      assert.match(output, /PASS 81\s+FAIL 0\s+GAP 0\s+HARNESS 0/);
    } else {
      assert.equal(result.status, 1, output);
      assert.match(output, /not ok \d+ - E2E-999 result matrix/);
      const message = fault === "empty" ? /Required E2E probe evidence is missing/
        : fault === "missing" ? /Required E2E probe inventory changed/
        : fault === "duplicate" ? /Required E2E probe identities must be unique/
        : /Required E2E probes did not pass/;
      assert.match(output, message);
      if (fault === "settlement" || fault === "analytics") {
        assert.match(output, new RegExp(`R01 deliberate ${fault} gate fault`));
      }
      // Exactly the matrix verdict must fail, not an unrelated setup or application test.
      assert.match(output, /# tests 15\s+# suites 0\s+# pass 14\s+# fail 1/);
    }
  });
}
