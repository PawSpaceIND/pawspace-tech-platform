import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/v2-scheduler-choice.yml", import.meta.url), "utf8");
const trigger = workflow.slice(workflow.indexOf("  pull_request:"), workflow.indexOf("  workflow_dispatch:"));
const paths = [...trigger.matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1]);
const covered = file => paths.some(pattern => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${regex}$`).test(file);
});

test("scheduler CI triggers when its shared browser configuration or server harness changes", () => {
  for (const path of ["playwright.config.ts", "playwright.scheduler-choice.config.ts", "scripts/e2e/serve.sh", "scripts/e2e/seed-identities.mjs", "package.json", "package-lock.json"])
    assert.ok(covered(path), `Missing scheduler CI trigger: ${path}`);
});
test("scheduler CI triggers for every executed regression and its shared fixtures", () => {
  const executed = [...workflow.matchAll(/\b(tests\/[\w/-]+\.test\.mjs)\b/g)].map(match => match[1]);
  assert.ok(executed.length >= 7, "keep the existing regression suite");
  for (const path of [...executed, "tests/helpers/module-hooks.mjs", "tests/helpers/execution-harness.mjs", "tests/fixtures/v2-ui-wiring-contract.json", "tests/scheduler-choice-ci-coverage.test.mjs"])
    assert.ok(covered(path), `Missing scheduler CI trigger: ${path}`);
});
