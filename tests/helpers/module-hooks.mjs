/**
 * Installs the resolver every real-execution suite needs: `cloudflare:workers` resolves to a stub that
 * reads a per-suite global, and lib modules that import each other extensionlessly resolve to `.ts`.
 *
 * `module.registerHooks` only exists from Node 22.15. CI pins 22.13.0, where calling it throws
 * `TypeError: nodeModule.registerHooks is not a function` and takes the whole file down before a single
 * test runs - which is exactly what it did. On that version the same resolver is registered as an
 * out-of-thread loader hook instead. Several suites already carried both branches inline; this is that
 * pattern in one place so a new suite cannot pick only the half that works on a newer laptop.
 */
import * as nodeModule from "node:module";

// envName defaults to `${globalName}_ENV`, which is what the suites written before it existed use. The
// two call sites that pass a name of their own (__FANOUT_ENV__, __SEED_ENV__) were setting a global the
// shim never read: it looked for __FANOUT_DB___ENV. Those suites need no env values, so nothing failed -
// the first suite to read one would have got undefined and no clue why.
export function installWorkersHooks(globalName, envName = `${globalName}_ENV`) {
  const shim = `export const env = new Proxy({}, { get: (_, key) => key === "DB" ? globalThis[${JSON.stringify(globalName)}] : (globalThis[${JSON.stringify(envName)}] ?? {})[key] });`;
  const workersUrl = `data:text/javascript,${encodeURIComponent(shim)}`;

  // The fallback below only runs on the Node CI pins, so on a newer machine it is never exercised -
  // which is how it came to be missing at all. PAWSPACE_FORCE_LOADER_HOOK=1 takes that path on any
  // version, so the suite can prove both branches work.
  const forceLoader = process.env.PAWSPACE_FORCE_LOADER_HOOK === "1";
  if (!forceLoader && typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
          throw error;
        }
      },
    });
    return workersUrl;
  }

  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
  return workersUrl;
}
