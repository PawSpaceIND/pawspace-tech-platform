import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

process.env.PAWSPACE_HOOK_PROCESS_FALLBACK = "process-value";
installWorkersHooks("__HOOK_ENV_DB__", "__HOOK_ENV__");
globalThis.__HOOK_ENV_DB__ = { id: "hook-db" };
globalThis.__HOOK_ENV__ = { PAWSPACE_HOOK_SUITE_OVERRIDE: "suite-value", PAWSPACE_HOOK_PROCESS_FALLBACK: "suite-wins" };

const { env } = await import("cloudflare:workers");

test("Workers shim keeps suite env precedence and falls back to process env", () => {
  assert.equal(env.DB.id, "hook-db");
  assert.equal(env.PAWSPACE_HOOK_SUITE_OVERRIDE, "suite-value");
  assert.equal(env.PAWSPACE_HOOK_PROCESS_FALLBACK, "suite-wins");
  assert.equal(env.PAWSPACE_LOCAL_PREVIEW, "on");
  assert.equal(env.NODE_ENV, "test");
});

test.after(() => {
  delete process.env.PAWSPACE_HOOK_PROCESS_FALLBACK;
  delete globalThis.__HOOK_ENV_DB__;
  delete globalThis.__HOOK_ENV__;
});
