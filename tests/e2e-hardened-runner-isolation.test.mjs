import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const runner = fs.readFileSync("scripts/e2e/run-hardened.sh", "utf8");

test("hardened multi-actor modes each get a fresh built-worker process without retries", () => {
  assert.match(runner, /for assignment_mode in auto admin_choice/);
  assert.match(runner, /start_server[\s\S]*--grep="correlated journey\.\*\$\{assignment_mode\}"/);
  assert.match(runner, /test-results\/\$\(basename .*\)\/\$project\/\$assignment_mode/);
  assert.match(runner, /stop_server[\s\S]*done[\s\S]*continue/);
  assert.doesNotMatch(runner, /04-multi-actor[^\n]*--retries/);
});
