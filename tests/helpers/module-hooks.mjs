/**
 * Installs the resolver every real-execution suite needs: `cloudflare:workers` resolves to a stub that
 * reads a per-suite global, and lib modules that import each other extensionlessly resolve to `.ts`.
 *
 * This harness remains test-only: production modules are deliberately not modified to satisfy loader fixtures.
 *
 * Node 22 runs the shared test harness through `node:module.register()`. The hook module is a real file URL,
 * so its package imports resolve against this repository and the runner no longer depends on the newer
 * synchronous `registerHooks()` API being present or behaving identically across Node 22 patch releases.
 */
import * as nodeModule from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped Worker DB for suites that call real routes. ESM caches the first
// `cloudflare:workers` shim, so later suites' named globals never reach `database()`.
// AsyncLocalStorage is the only isolation that survives a parallel `tests/*.test.mjs` run.
export const WORKERS_DB_ALS_KEY = "__PAWSPACE_SCOPED_WORKERS_DB__";
const workersDbAls = new AsyncLocalStorage();
globalThis[WORKERS_DB_ALS_KEY] = workersDbAls;

export function runWithWorkersDb(db, callback) {
  return workersDbAls.run(db, callback);
}

// envName defaults to `${globalName}_ENV`, which is what the suites written before it existed use. The
// two call sites that pass a name of their own (__FANOUT_ENV__, __SEED_ENV__) were setting a global the
// shim never read: it looked for __FANOUT_DB___ENV. Those suites need no env values, so nothing failed -
// the first suite to read one would have got undefined and no clue why.

// Each real-execution suite must own its Worker DB global. Re-registering the same global in one test
// process makes cloudflare:workers resolve to whichever suite wrote the global last, which can turn an
// authorization refusal into a fixture-dependent 500. Fail immediately instead of allowing that alias.
const installedWorkersDbGlobals = new Set();

function installModuleHooks(workersUrl) {
  if (typeof nodeModule.register !== "function") {
    throw new Error("PawSpace test harness requires node:module register() on Node 22");
  }

  // register() runs hooks in a separate thread. Give that thread a real file URL so its bare imports
  // resolve against this repository rather than a data: URL with no filesystem package scope/base path.
  // The worker shim remains per registration by encoding it in the file URL's query string.
  const loaderUrl = new URL("./module-loader-hook.mjs", import.meta.url);
  loaderUrl.searchParams.set("workersUrl", workersUrl);
  nodeModule.register(loaderUrl, import.meta.url);
  return workersUrl;
}

export function installWorkersHooks(globalName, envName = `${globalName}_ENV`) {
  process.env.NODE_ENV = "test";
  process.env.PAWSPACE_LOCAL_PREVIEW = "on";
  if (installedWorkersDbGlobals.has(globalName)) {
    throw new Error(`installWorkersHooks DB global already registered in this test process: ${globalName}`);
  }
  installedWorkersDbGlobals.add(globalName);

  const shim = `export const env = new Proxy({}, { get: (_, key) => { const als = globalThis[${JSON.stringify(WORKERS_DB_ALS_KEY)}]; const scoped = als && typeof als.getStore === "function" ? als.getStore() : undefined; if (key === "DB" && scoped) return scoped; return key === "DB" ? globalThis[${JSON.stringify(globalName)}] : (globalThis[${JSON.stringify(envName)}] ?? {})[key]; } });`;
  const workersUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
  return installModuleHooks(workersUrl);
}
