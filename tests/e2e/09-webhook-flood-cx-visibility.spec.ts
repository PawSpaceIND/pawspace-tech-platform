import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";

test("Razorpay capture plus Meta 503 is visible to CX as communication pending", async () => {
  const run = spawnSync(process.execPath, ["scripts/e2e/cx-communication-visibility.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 90_000,
  });
  expect(run.status, `CX visibility proof failed\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain('"result":"passed"');
  expect(run.stdout).toContain('"retryState":"retry_pending"');
  expect(run.stdout).toContain('"pendingFlagVisible":true');
  expect(run.stdout).toContain('"failedFlagVisible":true');
});
