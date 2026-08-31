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
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loaded lazily and cached: only a suite that actually imports a .tsx pays for TypeScript's compiler.
let cachedTs = null;
function typescript() {
  if (!cachedTs) cachedTs = nodeModule.createRequire(import.meta.url)("typescript");
  return cachedTs;
}
/*
 * The out-of-thread hook is handed to Node as a data: URL, and a data: URL module has no base path -
 * so `import "typescript"` inside it fails with ERR_UNSUPPORTED_RESOLVE_REQUEST, no matter what
 * parentURL register() is given. Resolving the absolute path here and interpolating it is what makes
 * that branch work, and that branch is the one CI's Node 22.13 pin actually takes.
 */
const typescriptUrl = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("typescript")).href;

// envName defaults to `${globalName}_ENV`, which is what the suites written before it existed use. The
// two call sites that pass a name of their own (__FANOUT_ENV__, __SEED_ENV__) were setting a global the
// shim never read: it looked for __FANOUT_DB___ENV. Those suites need no env values, so nothing failed -
// the first suite to read one would have got undefined and no clue why.

// Each real-execution suite must own its Worker DB global. Re-registering the same global in one test
// process makes cloudflare:workers resolve to whichever suite wrote the global last, which can turn an
// authorization refusal into a fixture-dependent 500. Fail immediately instead of allowing that alias.
const installedWorkersDbGlobals = new Set();

// Both hook branches below need the same two things, so they are written once, as source text, because
// the out-of-thread branch can only receive its hook as a string.
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

function loadWithRegisterHooksCompatibility(url, context, nextLoad) {
  try {
    return nextLoad(url, context);
  } catch (error) {
    // Node 22.15-22.18 can reject a null/undefined CommonJS source while synchronous hooks are chained
    // with another loader. Repair only that runtime defect; every other load failure remains authoritative.
    if (error?.code !== "ERR_INVALID_RETURN_PROPERTY_VALUE" || !url.startsWith("file:")) throw error;
    const path = fileURLToPath(url);
    return {
      format: context.format ?? (path.endsWith(".cjs") ? "commonjs" : "module"),
      source: readFileSync(path),
      shortCircuit: true,
    };
  }
}

export function installWorkersHooks(globalName, envName = `${globalName}_ENV`) {
  process.env.NODE_ENV = "test";
  process.env.PAWSPACE_LOCAL_PREVIEW = "on";
  if (installedWorkersDbGlobals.has(globalName)) {
    throw new Error(`installWorkersHooks DB global already registered in this test process: ${globalName}`);
  }
  installedWorkersDbGlobals.add(globalName);

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
          // .ts first, because that is what every lib module means by an extensionless import; .tsx only
          // when .ts is not there either, so a component's sibling import resolves too.
          if (specifier.startsWith(".") && !specifier.endsWith(".ts") && !specifier.endsWith(".tsx")) {
            try { return nextResolve(`${specifier}.ts`, context); }
            catch { return nextResolve(`${specifier}.tsx`, context); }
          }
          // A bare specifier into a package with no exports map - `next/link` is the one that matters -
          // resolves only with its extension. Reached ONLY after the real resolution has already failed,
          // so it can never change an import that works.
          if (!specifier.startsWith(".") && !specifier.endsWith(".js")) return nextResolve(`${specifier}.js`, context);
          throw error;
        }
      },
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) return { format: "module", source: cssStub(), shortCircuit: true };
        if (!url.endsWith(".tsx")) return loadWithRegisterHooksCompatibility(url, context, nextLoad);
        const path = fileURLToPath(url);
        return { format: "module", source: transpileTsx(readFileSync(path, "utf8"), path), shortCircuit: true };
      },
    });
    return workersUrl;
  }

  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  import * as tsModule from ${JSON.stringify(typescriptUrl)};
  import { readFile } from "node:fs/promises";
  import { fileURLToPath, pathToFileURL } from "node:url";
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
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
  return workersUrl;
}
