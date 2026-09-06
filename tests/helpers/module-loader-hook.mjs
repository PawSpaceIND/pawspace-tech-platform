import * as tsModule from "typescript";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const registrationUrl = new URL(import.meta.url);
const workersUrl = registrationUrl.searchParams.get("workersUrl");

if (!workersUrl) {
  throw new Error("PawSpace test loader hook requires a workersUrl registration parameter");
}

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

const CSS_STUB =
  'const handler={get:(_,key)=>typeof key==="string"?key:undefined};export default new Proxy({},handler);';

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

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: workersUrl, shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const { pathname, suffix } = splitSpecifierSuffix(specifier);
    if (pathname.startsWith(".") && !pathname.endsWith(".ts") && !pathname.endsWith(".tsx")) {
      try {
        return await nextResolve(`${pathname}.ts${suffix}`, context);
      } catch {
        return await nextResolve(`${pathname}.tsx${suffix}`, context);
      }
    }
    if (!pathname.startsWith(".") && !pathname.endsWith(".js")) {
      return await nextResolve(`${pathname}.js${suffix}`, context);
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  parsed.search = "";
  parsed.hash = "";

  if (pathname.endsWith(".css")) {
    return { format: "module", source: CSS_STUB, shortCircuit: true };
  }
  if (!pathname.endsWith(".tsx")) {
    return nextLoad(url, context);
  }

  const path = fileURLToPath(parsed);
  return {
    format: "module",
    source: transpileTsx(await readFile(path, "utf8"), path),
    shortCircuit: true,
  };
}
