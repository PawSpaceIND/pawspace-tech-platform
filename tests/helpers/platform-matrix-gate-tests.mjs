import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MATRIX_FAULTS } from "./platform-matrix-faults.mjs";
import { assertPlatformMatrix } from "./platform-matrix-verdict.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const fullFixture = fileURLToPath(new URL("../fixtures/platform-matrix-gate-child.mjs", import.meta.url));
const verdictFixture = fileURLToPath(new URL("../fixtures/platform-matrix-verdict-child.mjs", import.meta.url));
// An environment setting alone cannot suppress the parent scenarios.
export function isPlatformMatrixGateChild() {
  return process.argv[1] === fullFixture && MATRIX_FAULTS.includes(process.env.PAWSPACE_TEST_MATRIX_FAULT);
}
function runChild(fault, fixture, input) {
  const env = { ...process.env, PAWSPACE_TEST_MATRIX_FAULT: fault,
    PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_PAYMENT_ENV: "sandbox",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
    APP_ENV: "staging", NODE_ENV: "test", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on",
    PAWSPACE_VOICE_TRANSPORT: "local_simulator_non_production" };
  delete env.NODE_TEST_CONTEXT;
  delete env.PAWSPACE_TEST_MATRIX_EVIDENCE;
  if (input !== undefined) env.PAWSPACE_TEST_MATRIX_EVIDENCE = input;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test",
    "--test-reporter=tap", fixture], { cwd: root, env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "a killed runner is not a valid red-gate result");
  return result;
}
function verifyExit(result, fault, expectedTests) {
  const output = result.stdout + result.stderr;
  const healthy = fault === "none";
  assert.equal(result.status, healthy ? 0 : 1, output);
  assert.match(output, healthy ? /\nok \d+ - E2E-999 result matrix/ : /\nnot ok \d+ - E2E-999 result matrix/);
  assert.match(output, new RegExp(`# tests ${expectedTests}\\s+# suites 0\\s+# pass ${expectedTests - (healthy ? 0 : 1)}\\s+# fail ${healthy ? 0 : 1}`));
  if (!healthy) {
    const message = fault === "empty" ? /Required E2E probe evidence is missing/
      : fault === "missing" ? /Required E2E probe inventory changed/
      : fault === "duplicate" ? /Required E2E probe identities must be unique/
      : fault === "replacement" ? /Required E2E probe identities do not match/
      : /Required E2E probes did not pass/;
    assert.match(output, message);
    if (fault === "settlement" || fault === "analytics") assert.match(output, new RegExp(`R01 deliberate ${fault} gate fault`));
  }
}
export function registerPlatformMatrixGateTests(results) {
  for (const fault of MATRIX_FAULTS) {
    test(`actual platform matrix release gate: ${fault}`, { timeout: 65000 }, () => {
      assertPlatformMatrix(results);
      verifyExit(runChild(fault, verdictFixture, JSON.stringify(results)), fault, 1);
    });
  }
  for (const fault of ["none", "replacement"]) {
    test(`full platform runner verdict wiring: ${fault}`, { timeout: 65000 }, () => {
      assertPlatformMatrix(results);
      verifyExit(runChild(fault, fullFixture), fault, 15);
    });
  }
}
