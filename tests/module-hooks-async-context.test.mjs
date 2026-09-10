import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

const DEFAULT_DB = Object.freeze({ scope: "default" });
const DB_A = Object.freeze({ scope: "A" });
const DB_B = Object.freeze({ scope: "B" });

globalThis.__MODULE_HOOK_ASYNC_CONTEXT_DB__ = DEFAULT_DB;
globalThis.__MODULE_HOOK_ASYNC_CONTEXT_ENV__ = {};
installWorkersHooks("__MODULE_HOOK_ASYNC_CONTEXT_DB__", "__MODULE_HOOK_ASYNC_CONTEXT_ENV__");

const { env } = await import("cloudflare:workers");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("cloudflare:workers DB stays isolated across overlapping AsyncLocalStorage scopes", async () => {
  assert.strictEqual(env.DB, DEFAULT_DB, "outside a scoped callback the suite DB remains the fallback");
  assert.equal(
    Object.prototype.hasOwnProperty.call(globalThis, "__PAWSPACE_ACTIVE_WORKERS_DB__"),
    false,
    "the legacy process-global active DB slot must not be recreated",
  );

  const aReady = deferred();
  const bReady = deferred();
  const release = deferred();

  const taskA = runWithWorkersDb(DB_A, async () => {
    assert.strictEqual(env.DB, DB_A, "scope A must receive DB_A before yielding");
    aReady.resolve();
    await release.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(env.DB, DB_A, "scope A must retain DB_A after overlapping async work");
  });

  const taskB = runWithWorkersDb(DB_B, async () => {
    assert.strictEqual(env.DB, DB_B, "scope B must receive DB_B before yielding");
    bReady.resolve();
    await release.promise;
    await Promise.resolve();
    assert.strictEqual(env.DB, DB_B, "scope B must retain DB_B after overlapping async work");
  });

  await Promise.all([aReady.promise, bReady.promise]);
  assert.strictEqual(env.DB, DEFAULT_DB, "the caller must not inherit either active DB scope");

  release.resolve();
  await Promise.all([taskA, taskB]);

  assert.strictEqual(env.DB, DEFAULT_DB, "scoped DB bindings must be released after completion");
  assert.equal(
    Object.prototype.hasOwnProperty.call(globalThis, "__PAWSPACE_ACTIVE_WORKERS_DB__"),
    false,
    "concurrent execution must not fall back to the legacy process-global active DB slot",
  );
});
