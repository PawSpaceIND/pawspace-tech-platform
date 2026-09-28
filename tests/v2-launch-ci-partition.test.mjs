import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { parsePaymentEnvironment, sandboxCapabilitiesUnlocked } from "../lib/payment-environment.ts";

const workflow = yaml.load(readFileSync(new URL("../.github/workflows/v2-launch-resilience.yml", import.meta.url), "utf8"));
const config = readFileSync(new URL("../playwright.launch-readiness.config.ts", import.meta.url), "utf8");

test("launch CI partitions every existing browser project exactly once, without reducing coverage", () => {
  const browser = workflow.jobs["browser-compatibility"];
  assert.ok(browser, "browser coverage must not share the serial offline job's timeout");
  const projects = [...config.matchAll(/\{name:\s*"([^"]+)"/g)].map(match => match[1]);
  const groups = browser.strategy.matrix.include;
  const assigned = groups.flatMap(group => [...group.projects.matchAll(/--project=([\w-]+)/g)].map(match => match[1]));
  assert.ok(projects.length >= 10);
  assert.deepEqual([...assigned].sort(), [...projects].sort());
  assert.equal(new Set(assigned).size, assigned.length, "no duplicated or omitted project");
  assert.equal(browser.strategy["fail-fast"], false, "one failure must not erase other browser evidence");
  assert.ok(browser.strategy["max-parallel"] > 1 && browser.strategy["max-parallel"] <= 4);
  assert.equal(browser["timeout-minutes"], 30, "partition the work rather than raising the deadline");
  const run = browser.steps.find(step => step.name === "Run assigned browser projects").run;
  assert.match(run, /--config playwright\.launch-readiness\.config\.ts/);
  assert.match(run, /\$\{\{ matrix\.projects \}\}/);
  assert.doesNotMatch(run, /--grep|--retries|--workers|\|\|\s*true/);
});

test("all partitions retain sandbox locks and independent failure evidence", () => {
  for (const name of ["offline-checks", "browser-compatibility"]) {
    const job = workflow.jobs[name];
    assert.ok(job, `missing ${name}`);
    assert.equal(job.env.PAWSPACE_PAYMENT_ENV, "sandbox");
    assert.equal(job.env.PAWSPACE_PAYMENT_LIVE_APPROVED, "false");
    assert.equal(job.env.FORBID_PRODUCTION, "true");
    assert.equal(job["continue-on-error"], undefined);
    assert.ok(job.steps.every(step => step["continue-on-error"] === undefined));
  }
  const artifact = workflow.jobs["browser-compatibility"].steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(artifact.if, "always()");
  assert.match(artifact.with.name, /matrix\.name/);
  assert.match(artifact.with.name, /github\.sha/);
  const offline = workflow.jobs["offline-checks"].steps.map(step => step.run || "").join("\n");
  for (const file of ["v2-network-recovery", "provider-proof-offline-queue", "uat-phase3-partner-tracking", "frontend-chaos-hardening", "global-chaos-hardening-source-contract", "partner-app-login-gate", "partner-proof-upload-chain", "service-proof-verification-wiring", "booking-fanout-atomicity-real-d1", "scheduling-rules-authorization-real-d1"])
    assert.ok(offline.includes(`tests/${file}.test.mjs`), file);
});

test("the original compatibility gate passes only when every required partition succeeds", () => {
  const gate = workflow.jobs.compatibility;
  assert.equal(gate.if, "always()");
  assert.deepEqual([...gate.needs].sort(), ["browser-compatibility", "offline-checks"]);
  const run = gate.steps.find(step => step.name === "Require complete compatibility evidence").run;
  for (const offline of ["success", "failure", "cancelled", "skipped"]) for (const browser of ["success", "failure", "cancelled", "skipped"]) {
    const result = spawnSync("bash", ["-e", "-c", run], { env: { ...process.env, OFFLINE_RESULT: offline, BROWSER_RESULT: browser } });
    assert.equal(result.status === 0, offline === "success" && browser === "success", `${offline}/${browser}`);
  }
});


// YAML flags alone do not prove isolation. Execute the same production parser used by payment
// operations against every partition's effective job/step environment, without network or credentials.
for (const jobName of ["offline-checks", "browser-compatibility"]) {
  test(`CI partition ${jobName} executes the real sandbox boundary for all run steps`, () => {
    const job = workflow.jobs[jobName];
    const steps = job.steps.filter(step => typeof step.run === "string");
    assert.ok(steps.length > 0, `${jobName} must execute work`);
    for (const step of steps) {
      const env = Object.freeze({ ...workflow.env, ...job.env, ...step.env });
      const label = `${jobName}/${step.name || step.run}`;
      assert.equal(parsePaymentEnvironment(env), "sandbox", label);
      assert.equal(sandboxCapabilitiesUnlocked(env), true, label);
      for (const mode of ["live", "LIVE", "production", " sandbox", "sandbox ", "", undefined]) {
        const unsafe = { ...env, PAWSPACE_PAYMENT_ENV: mode, PAWSPACE_PAYMENT_LIVE_APPROVED: "true" };
        assert.throws(() => parsePaymentEnvironment(unsafe),
          mode === "live" ? /FORBID_PRODUCTION blocks live payments/ : /must be exactly/, `${label}/${mode}`);
        assert.equal(sandboxCapabilitiesUnlocked(unsafe), false, `${label}/${mode}`);
      }
      const misbound = { ...env, RAZORPAY_KEY_ID_SANDBOX: "rzp_live_ci_fixture_not_a_key" };
      assert.throws(() => parsePaymentEnvironment(misbound), /forbidden in sandbox/, label);
      assert.equal(sandboxCapabilitiesUnlocked(misbound), false, label);
      assert.equal(env.PAWSPACE_PAYMENT_ENV, "sandbox", "validation must not mutate the workflow input");
    }
  });
}
