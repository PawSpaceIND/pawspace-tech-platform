/**
 * Installs the resolver every real-execution suite needs: `cloudflare:workers` resolves to a stub that
 * reads a per-suite global, and lib modules that import each other extensionlessly resolve to `.ts`.
 *
 * Node's public customization-hook API is `module.register()`. The normal Node >= 22.15 path uses the
 * named public export with this module's URL as its parent, while PAWSPACE_FORCE_LOADER_HOOK keeps the
 * namespace-export invocation exercised as the compatibility path. Both registrations install the exact
 * same resolver/loader source so TypeScript and CSS handling cannot drift between CI paths.
 */
import * as nodeModule from "node:module";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/*
 * The out-of-thread hook is handed to Node as a data: URL, and a data: URL module has no base path -
 * so `import "typescript"` inside it fails with ERR_UNSUPPORTED_RESOLVE_REQUEST. Resolving the absolute
 * TypeScript path here and interpolating it keeps the registered hook independent of the data: URL base.
 */
const typescriptUrl = pathToFileURL(require.resolve("typescript")).href;

// envName defaults to `${globalName}_ENV`, which is what the suites written before it existed use. The
// two call sites that pass a name of their own (__FANOUT_ENV__, __SEED_ENV__) were setting a global the
// shim never read: it looked for __FANOUT_DB___ENV. Those suites need no env values, so nothing failed -
// the first suite to read one would have got undefined and no clue why.

// Each real-execution suite must own its Worker DB global. Re-registering the same global in one test
// process makes cloudflare:workers resolve to whichever suite wrote the global last, which can turn an
// authorization refusal into a fixture-dependent 500. Fail immediately instead of allowing that alias.
const installedWorkersDbGlobals = new Set();

// Both registration paths below need the same TypeScript transform and CSS stub, so they are written once
// as source text for the out-of-thread loader module registered through node:module.register().
const TSX_TRANSFORM = `
  function transpileTsx(source, fileName) {
    const ts = tsModule.default ?? tsModule;
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
  // A component that imports a CSS module wants an object whose every key is a class name. Returning a
  // Proxy rather than {} means a style lookup yields a string instead of undefined, so a className never
  // renders as the literal "undefined" and a missing stylesheet cannot be mistaken for a render bug.
  const CSS_STUB = "const handler={get:(_,key)=>typeof key===\\"string\\"?key:undefined};export default new Proxy({},handler);";
`;

export function installWorkersHooks(globalName, envName = `${globalName}_ENV`) {
  process.env.NODE_ENV = "test";
  process.env.PAWSPACE_LOCAL_PREVIEW = "on";
  if (installedWorkersDbGlobals.has(globalName)) {
    throw new Error(`installWorkersHooks DB global already registered in this test process: ${globalName}`);
  }
  installedWorkersDbGlobals.add(globalName);

  const shim = `export const env = new Proxy({}, { get: (_, key) => key === "DB" ? globalThis[${JSON.stringify(globalName)}] : (globalThis[${JSON.stringify(envName)}] ?? {})[key] });`;
  const workersUrl = `data:text/javascript,${encodeURIComponent(shim)}`;

  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  import * as tsModule from ${JSON.stringify(typescriptUrl)};
  import { readFile } from "node:fs/promises";
  import { fileURLToPath } from "node:url";
  ${TSX_TRANSFORM}
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts") && !specifier.endsWith(".tsx")) {
        try { return await nextResolve(specifier + ".ts", context); }
        catch { return await nextResolve(specifier + ".tsx", context); }
      }
      if (!specifier.startsWith(".") && !specifier.endsWith(".js")) return await nextResolve(specifier + ".js", context);
      throw error;
    }
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: CSS_STUB, shortCircuit: true };
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    return { format: "module", source: transpileTsx(await readFile(path, "utf8"), path), shortCircuit: true };
  }`;
  const hookUrl = new URL(`data:text/javascript,${encodeURIComponent(hook)}`);

  // The primary Node >= 22.15 path must use the public named register() export. The forced compatibility
  // path keeps the namespace export exercised, but both are the same public API and both receive an
  // explicit parent URL so relative/custom specifier resolution is anchored to this module.
  const forceLoader = process.env.PAWSPACE_FORCE_LOADER_HOOK === "1";
  if (!forceLoader) {
    if (typeof register !== "function") {
      throw new TypeError("node:module.register is not available in this Node runtime");
    }
    register(hookUrl, import.meta.url);
    return workersUrl;
  }

  if (typeof nodeModule.register !== "function") {
    throw new TypeError("node:module.register is not available in this Node runtime");
  }
  nodeModule.register(hookUrl, import.meta.url);
  return workersUrl;
}
