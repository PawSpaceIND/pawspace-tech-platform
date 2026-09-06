import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function transpileTsx(source, fileName) {
  const ts = nodeModule.createRequire(import.meta.url)("typescript");
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

const CSS_STUB = 'const handler={get:(_,key)=>typeof key==="string"?key:undefined};export default new Proxy({},handler);';

function splitSpecifierSuffix(specifier) {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const suffixIndex = indexes.length ? Math.min(...indexes) : specifier.length;
  return { pathname: specifier.slice(0, suffixIndex), suffix: specifier.slice(suffixIndex) };
}

function resolveHook(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const { pathname, suffix } = splitSpecifierSuffix(specifier);
    if (pathname.startsWith(".") && !pathname.endsWith(".ts") && !pathname.endsWith(".tsx")) {
      try {
        return nextResolve(`${pathname}.ts${suffix}`, context);
      } catch {
        return nextResolve(`${pathname}.tsx${suffix}`, context);
      }
    }
    if (!pathname.startsWith(".") && !pathname.endsWith(".js")) {
      return nextResolve(`${pathname}.js${suffix}`, context);
    }
    throw error;
  }
}

function loadHook(url, context, nextLoad) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  parsed.search = "";
  parsed.hash = "";
  if (pathname.endsWith(".css")) {
    return { format: "module", source: CSS_STUB, shortCircuit: true };
  }
  if (!pathname.endsWith(".tsx")) return nextLoad(url, context);
  const path = fileURLToPath(parsed);
  return {
    format: "module",
    source: transpileTsx(readFileSync(path, "utf8"), path),
    shortCircuit: true,
  };
}

function installRegisterHooks() {
  if (typeof nodeModule.registerHooks !== "function") {
    throw new Error("node:module.registerHooks() is unavailable on this runtime");
  }
  // registerHooks() is a synchronous API. Keep this branch completely independent from the
  // out-of-thread module.register() loader so a loader promise can never leak into a sync hook.
  nodeModule.registerHooks({ resolve: resolveHook, load: loadHook });
}

function installLoaderFallback(registerHooksError = null) {
  if (typeof nodeModule.register !== "function") {
    if (registerHooksError) throw registerHooksError;
    throw new Error("PawSpace shared test hooks require node:module register() or registerHooks()");
  }
  try {
    // module.register() owns the asynchronous/out-of-thread loader path. It is invoked only after
    // the synchronous branch is bypassed or fails during registration, never from inside its hooks.
    nodeModule.register(new URL("./module-loader-base.mjs", import.meta.url), import.meta.url);
  } catch (error) {
    if (registerHooksError) {
      throw new AggregateError(
        [registerHooksError, error],
        "PawSpace shared test hooks could not register either Node module hook path",
      );
    }
    throw error;
  }
}

const forceLoader =
  process.env.PAWSPACE_FORCE_LOADER_HOOK === "1" ||
  process.env.PAWSPACE_FORCE_LOADER_FALLBACK === "1";
const forceRegisterHooks = process.env.PAWSPACE_FORCE_REGISTER_HOOKS === "1";

if (forceLoader && forceRegisterHooks) {
  throw new Error("Cannot force registerHooks() and the module.register() loader fallback at the same time");
}

let registerHooksError = null;
let installedRegisterHooks = false;
if (!forceLoader && typeof nodeModule.registerHooks === "function") {
  try {
    installRegisterHooks();
    installedRegisterHooks = true;
  } catch (error) {
    registerHooksError = error;
    if (forceRegisterHooks) throw error;
  }
} else if (forceRegisterHooks) {
  throw new Error("node:module.registerHooks() is unavailable on this runtime");
}

if (!installedRegisterHooks) installLoaderFallback(registerHooksError);
