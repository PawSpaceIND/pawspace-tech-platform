/**
 * Installs the resolver every real-execution suite needs: `cloudflare:workers` resolves to a stub that
 * reads a per-suite global, and lib modules that import each other extensionlessly resolve to `.ts`.
 *
 * This harness remains test-only: production modules are deliberately not modified to satisfy loader fixtures.
 *
 * `module.registerHooks` exists from Node 22.15. The synchronous branch is preferred when available.
 * The out-of-thread `module.register()` branch remains as a compatibility fallback and can still be
 * forced in tests with PAWSPACE_FORCE_LOADER_HOOK=1.
 */
import * as nodeModule from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve both public Node hook APIs once. Node 22.15+ exposes registerHooks(); older supported Node 22
// builds expose register(). Keeping the feature test here means the rest of the harness never calls a
// missing export and the forced-loader CI path proves the compatibility branch on the same runner.
const registerHooks = typeof nodeModule.registerHooks === "function" ? nodeModule.registerHooks : null;
const register = typeof nodeModule.register === "function" ? nodeModule.register : null;

// Request-scoped Worker DB for suites that call real routes. ESM caches the first
// `cloudflare:workers` shim, so later suites' named globals never reach `database()`.
// AsyncLocalStorage is the only isolation that survives a parallel `tests/*.test.mjs` run.
export const WORKERS_DB_ALS_KEY = "__PAWSPACE_SCOPED_WORKERS_DB__";
const workersDbAls = new AsyncLocalStorage();
globalThis[WORKERS_DB_ALS_KEY] = workersDbAls;

export function runWithWorkersDb(db, callback) {
  return workersDbAls.run(db, callback);
}

// Loaded lazily and cached: only a suite that actually imports a .tsx pays for TypeScript's compiler.
let cachedTs = null;
function typescript() {
  if (!cachedTs) cachedTs = nodeModule.createRequire(import.meta.url)("typescript");
  return cachedTs;
}

// envName defaults to `${globalName}_ENV`, which is what the suites written before it existed use. The
// two call sites that pass a name of their own (__FANOUT_ENV__, __SEED_ENV__) were setting a global the
// shim never read: it looked for __FANOUT_DB___ENV. Those suites need no env values, so nothing failed -
// the first suite to read one would have got undefined and no clue why.

// Each real-execution suite must own its Worker DB global. Re-registering the same global in one test
// process makes cloudflare:workers resolve to whichever suite wrote the global last, which can turn an
// authorization refusal into a fixture-dependent 500. Fail immediately instead of allowing that alias.
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
  return {
    pathname: specifier.slice(0, suffixIndex),
    suffix: specifier.slice(suffixIndex),
  };
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

  // PAWSPACE_FORCE_LOADER_HOOK=1 deliberately exercises the compatibility branch in CI.
  const forceLoader = process.env.PAWSPACE_FORCE_LOADER_HOOK === "1";
  if (!forceLoader && registerHooks) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          const { pathname, suffix } = splitSpecifierSuffix(specifier);
          // .ts first, because that is what every lib module means by an extensionless import; .tsx only
          // when .ts is not there either, so a component's sibling import resolves too. Keep any query/hash
          // suffix after the extension so Node receives ./module.ts?register rather than ./module?register.ts.
          if (pathname.startsWith(".") && !pathname.endsWith(".ts") && !pathname.endsWith(".tsx")) {
            try { return nextResolve(`${pathname}.ts${suffix}`, context); }
            catch { return nextResolve(`${pathname}.tsx${suffix}`, context); }
          }
          // A bare specifier into a package with no exports map - `next/link` is the one that matters -
          // resolves only with its extension. Reached ONLY after the real resolution has already failed,
          // so it can never change an import that works.
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
  }

  if (!register) {
    throw new Error("PawSpace test harness requires node:module register() when registerHooks() is unavailable or bypassed");
  }
  // register() runs hooks in a separate thread. Give that thread a real file URL so its bare imports
  // resolve against this repository rather than a data: URL with no filesystem package scope/base path.
  // The worker shim remains per registration by encoding it in the file URL's query string.
  const loaderUrl = new URL("./module-loader-hook.mjs", import.meta.url);
  loaderUrl.searchParams.set("workersUrl", workersUrl);
  register(loaderUrl, import.meta.url);
  return workersUrl;
}
