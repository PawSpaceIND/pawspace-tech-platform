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

/*
 * name -> promise that RESOLVES ONCE `${name}.mjs` IS ON DISK, carrying that module's lib/ deps.
 *
 * It was a Set of names, marked before the write rather than after, so a second caller arriving
 * while the first was still inside writeFile saw the name already present, skipped the write and
 * imported a file that was empty or half-written. Holding the promise instead makes the second
 * caller await the first caller's write, which is the thing it actually needs to happen.
 *
 * The promise deliberately covers this module's OWN file and not its dependencies': lib/ has import
 * cycles (provider-capacity-governance <-> provider-assignment-eligibility), and a promise that
 * waited for the whole subtree would, on a cycle, wait for itself. The worklist below walks the
 * graph instead, so a cycle is just a name already started.
 */
const emitted = new Map();

function workspace() {
  if (!dirPromise) {
    dirPromise = mkdtemp(path.join(os.tmpdir(), "pawspace-lib-")).then((dir) => {
      process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ } });
      return dir;
    });
  }
  return dirPromise;
}

/** Transpile one lib module into `dir`, resolving to the lib/ modules it imports. */
function emitOne(dir, name) {
  const existing = emitted.get(name);
  if (existing) return existing;
  const write = (async () => {
    const source = await readFile(path.join(LIB, `${name}.ts`), "utf8");
    const deps = [];
    /* Point every relative import at the .mjs sibling this loader is about to write. A specifier
     * that names no lib/ file is left exactly as it was - it resolves for Node already, and
     * rewriting it would break it. */
    const rewritten = source.replace(RELATIVE_IMPORT, (match, head, quote, target) => {
      const bare = target.replace(/\.(ts|tsx|js|mjs)$/, "");
      if (!existsSync(path.join(LIB, `${bare}.ts`))) return match;
      deps.push(bare);
      return `${head}${quote}./${bare}.mjs${quote}`;
    });
    await writeFile(path.join(dir, `${name}.mjs`), transpile(rewritten));
    return deps;
  })();
  emitted.set(name, write);
  return write;
}

export async function importLibModule(entry) {
  const dir = await workspace();
  const queue = [entry];
  const started = new Set();
  const writes = [];
  while (queue.length) {
    const name = queue.shift();
    if (started.has(name)) continue;
    started.add(name);
    const write = emitOne(dir, name);
    writes.push(write);
    queue.push(...await write);
  }
  /* Every file in the graph is on disk before anything imports it - including files another caller
   * started, which is the whole point of sharing the map. */
  await Promise.all(writes);
  return import(pathToFileURL(path.join(dir, `${entry}.mjs`)).href);
}
