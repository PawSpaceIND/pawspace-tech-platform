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

if (typeof nodeModule.registerHooks === "function" && process.env.PAWSPACE_FORCE_LOADER_HOOK !== "1") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
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
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      parsed.search = "";
      parsed.hash = "";
      if (pathname.endsWith(".css")) return { format: "module", source: CSS_STUB, shortCircuit: true };
      if (!pathname.endsWith(".tsx")) return nextLoad(url, context);
      const path = fileURLToPath(parsed);
      return { format: "module", source: transpileTsx(readFileSync(path, "utf8"), path), shortCircuit: true };
    },
  });
} else {
  if (typeof nodeModule.register !== "function") throw new Error("PawSpace shared test hooks require node:module register() or registerHooks()");
  nodeModule.register(new URL("./module-loader-base.mjs", import.meta.url), import.meta.url);
}
