import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));

test("installWorkersHooks rejects a repeated DB global in the same test process", () => {
  const globalName = "__MODULE_HOOK_COLLISION_PROOF_DB__";
  installWorkersHooks(globalName);
  assert.throws(
    () => installWorkersHooks(globalName),
    /DB global already registered.*__MODULE_HOOK_COLLISION_PROOF_DB__/,
    "a second suite must not be allowed to silently retarget cloudflare:workers to the same global",
  );
});

test("Training real-execution suites use unique Worker DB globals", () => {
  const trainingFiles = readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.mjs") && name.toLowerCase().includes("training"));

  const owners = new Map();
  const duplicates = [];
  const hookPattern = /installWorkersHooks\(\s*["']([^"']+)["']/g;

  for (const file of trainingFiles) {
    const source = readFileSync(join(testsDir, file), "utf8");
    for (const match of source.matchAll(hookPattern)) {
      const globalName = match[1];
      const prior = owners.get(globalName);
      if (prior) duplicates.push(`${globalName}: ${prior}, ${file}`);
      else owners.set(globalName, file);
    }
  }

  assert.deepEqual(
    duplicates,
    [],
    `Training Worker-hook DB globals must be suite-unique; collisions: ${duplicates.join("; ")}`,
  );
  assert.equal(
    owners.get("__TRAINING_CAPTURE_DB__"),
    "ptja-p1-training-capture-attestation.test.mjs",
    "the capture-attestation suite keeps ownership of its original global",
  );
  assert.equal(
    owners.get("__TRAINING_PAYMENT_GATEWAY_DB__"),
    "training-payment-sandbox-gateway-authorization.test.mjs",
    "the payment-gateway suite owns a separate global",
  );
});
