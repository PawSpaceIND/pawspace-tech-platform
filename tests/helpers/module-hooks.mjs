/**
 * Installs the resolver every real-execution suite needs: `cloudflare:workers` resolves to a stub that
 * reads a per-suite global, and lib modules that import each other extensionlessly resolve to `.ts`.
 * Test authorization is deliberately NOT granted through PAWSPACE_LOCAL_PREVIEW: local functional
 * requests receive independently-scoped actors from scoped-test-auth.mjs instead.
 */
import * as nodeModule from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {installScopedRequestActors,wrapDbWithScopedActors} from "./scoped-test-auth.mjs";

export const WORKERS_DB_ALS_KEY = "__PAWSPACE_SCOPED_WORKERS_DB__";
const workersDbAls = new AsyncLocalStorage();
globalThis[WORKERS_DB_ALS_KEY] = workersDbAls;

export function runWithWorkersDb(db, callback) {
  return workersDbAls.run(db, callback);
}

let cachedTs = null;
function typescript() {
  if (!cachedTs) cachedTs = nodeModule.createRequire(import.meta.url)("typescript");
  return cachedTs;
}

const installedWorkersDbGlobals = new Set();

function transpileTsx(source, fileName) {
  const ts = typescript();
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "react",
      verbatimModuleSyntax: false,
    },
  }).outputText;
}
const cssStub = () => 'const handler={get:(_,key)=>typeof key==="string"?key:undefined};export default new Proxy({},handler);';

function normalizedFileUrl(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  parsed.search = "";
  parsed.hash = "";
  return { pathname, parsed };
}

function splitSpecifierSuffix(specifier) {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");
  const suffixIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const suffixIndex = suffixIndexes.length ? Math.min(...suffixIndexes) : specifier.length;
  return { pathname: specifier.slice(0, suffixIndex), suffix: specifier.slice(suffixIndex) };
}

function installLoaderFallback(workersUrl, registerHooksError = null) {
  if (typeof nodeModule.register !== "function") {
    if (registerHooksError) throw registerHooksError;
    throw new Error("PawSpace test harness requires node:module register() when registerHooks() is unavailable or bypassed");
  }
  const loaderUrl = new URL("./module-loader-hook.mjs", import.meta.url);
  loaderUrl.searchParams.set("workersUrl", workersUrl);
  try {
    nodeModule.register(loaderUrl, import.meta.url);
  } catch (error) {
    if (registerHooksError) throw new AggregateError([registerHooksError, error], "PawSpace test harness could not register either Node module hook path");
    throw error;
  }
  return workersUrl;
}

export function installWorkersHooks(globalName, envName = `${globalName}_ENV`) {
  process.env.NODE_ENV = "test";
  delete process.env.PAWSPACE_LOCAL_PREVIEW;
  installScopedRequestActors();
  globalThis.__PAWSPACE_WRAP_SCOPED_TEST_DB__ = wrapDbWithScopedActors;

  if (installedWorkersDbGlobals.has(globalName)) {
    throw new Error(`installWorkersHooks DB global already registered in this test process: ${globalName}`);
  }
  installedWorkersDbGlobals.add(globalName);

  const shim = `export const env = new Proxy({}, { get: (_, key) => { const als = globalThis[${JSON.stringify(WORKERS_DB_ALS_KEY)}]; const scoped = als && typeof als.getStore === "function" ? als.getStore() : undefined; if (key === "DB") { const raw = scoped || globalThis[${JSON.stringify(globalName)}]; const wrap = globalThis.__PAWSPACE_WRAP_SCOPED_TEST_DB__; return typeof wrap === "function" ? wrap(raw) : raw; } return (globalThis[${JSON.stringify(envName)}] ?? {})[key]; } });`;
  const workersUrl = `data:text/javascript,${encodeURIComponent(shim)}`;

  // Node 22.15+ prefers registerHooks synchronously. CI can force the compatibility
  // path on the same runtime to prove module.register() still works.
  const forceLoader = process.env.PAWSPACE_FORCE_LOADER_HOOK === "1";
  if (!forceLoader && typeof nodeModule.registerHooks === "function") {
    try {
      nodeModule.registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
          try {
            return nextResolve(specifier, context);
          } catch (error) {
            const { pathname, suffix } = splitSpecifierSuffix(specifier);
            if (pathname.startsWith(".") && !pathname.endsWith(".ts") && !pathname.endsWith(".tsx")) {
              try { return nextResolve(`${pathname}.ts${suffix}`, context); }
              catch { return nextResolve(`${pathname}.tsx${suffix}`, context); }
            }
            if (!pathname.startsWith(".") && !pathname.endsWith(".js")) return nextResolve(`${pathname}.js${suffix}`, context);
            throw error;
          }
        },
        load(url, context, nextLoad) {
          const { pathname, parsed } = normalizedFileUrl(url);
          if (pathname.endsWith(".css")) return { format: "module", source: cssStub(), shortCircuit: true };
          if (!pathname.endsWith(".tsx")) return nextLoad(url, context);
          const path = fileURLToPath(parsed);
          return { format: "module", source: transpileTsx(readFileSync(path, "utf8"), path), shortCircuit: true };
        },
      });
      return workersUrl;
    } catch (error) {
      return installLoaderFallback(workersUrl, error);
    }
  }
  return installLoaderFallback(workersUrl);
}
