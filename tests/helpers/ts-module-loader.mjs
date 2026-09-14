/*
 * Import a lib/ TypeScript module, and its transitive lib/ dependencies, into a test.
 *
 * `node --experimental-strip-types` - what the suite runs with - strips types but does NOT resolve
 * extensionless specifiers, and this codebase writes every lib-to-lib import extensionless
 * (524 of them, none with a .ts suffix). So `import ... from "../lib/provider-workspace.ts"` fails on
 * the first hop with ERR_MODULE_NOT_FOUND, and any module with dependencies is unreachable from a
 * test. That is why so many suites for such modules assert on source text instead: not because
 * behaviour did not matter, but because behaviour was not reachable.
 *
 * tests/financial-lifecycle-executable-concurrency.test.mjs solved this by transpiling its four
 * modules to a temp directory by hand and rewriting each import. This is that approach with the
 * graph walked automatically, so a module with nineteen transitive dependencies costs the same as one
 * with none.
 *
 * Transpile-only, exactly like the original: no typecheck (npm run typecheck owns that), and the
 * emitted JavaScript is the same code the bundler would emit.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const LIB = fileURLToPath(new URL("../../lib/", import.meta.url));
const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(["'])\.\/([a-zA-Z0-9._-]+)\2/g;

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
}).outputText;

/**
 * @param entry  module name under lib/, without extension (e.g. "provider-workspace")
 * @returns the module's exports
 */
/*
 * ONE directory per process, removed when the process exits.
 *
 * A directory per call left emitted modules accumulating in the system temp directory: `node --test`
 * runs each suite in its own process, but a suite calling this twice leaked twice, and CI runs the
 * whole suite repeatedly on the same runner. Emitted files are named after the module, so sharing a
 * directory cannot collide; `emitted` is process-wide for the same reason, and makes a second call
 * for an already-written module free.
 *
 * Removal happens at exit rather than after the import resolves, because a module transpiled here
 * may be imported again later in the same process and Node would then have nothing to read.
 */
let dirPromise = null;
const emitted = new Set();

function workspace() {
  if (!dirPromise) {
    dirPromise = mkdtemp(path.join(os.tmpdir(), "pawspace-lib-")).then((dir) => {
      process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ } });
      return dir;
    });
  }
  return dirPromise;
}

export async function importLibModule(entry) {
  const dir = await workspace();

  async function emit(name) {
    if (emitted.has(name)) return;
    emitted.add(name);
    const source = await readFile(path.join(LIB, `${name}.ts`), "utf8");
    const pending = [];
    /* Point every relative import at the .mjs sibling this loader is about to write. A specifier
     * that names no lib/ file is left exactly as it was - it resolves for Node already, and
     * rewriting it would break it. */
    const rewritten = source.replace(RELATIVE_IMPORT, (match, head, quote, target) => {
      const bare = target.replace(/\.(ts|tsx|js|mjs)$/, "");
      if (!existsSync(path.join(LIB, `${bare}.ts`))) return match;
      pending.push(bare);
      return `${head}${quote}./${bare}.mjs${quote}`;
    });
    await writeFile(path.join(dir, `${name}.mjs`), transpile(rewritten));
    for (const dep of pending) await emit(dep);
  }

  await emit(entry);
  return import(pathToFileURL(path.join(dir, `${entry}.mjs`)).href);
}
