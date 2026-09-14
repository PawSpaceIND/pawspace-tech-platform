/*
 * A client component must not be able to REACH server-only code through its imports.
 *
 * The browser bundle has no `cloudflare:workers`, no D1 binding and no secrets. Vite refuses to
 * resolve the specifier and the whole build dies — not with a pointer to the client component that
 * caused it, but with the name of the deep module that holds the import:
 *
 *   Rolldown failed to resolve import "cloudflare:workers"
 *   from "lib/provider-assignment-eligibility.ts"
 *
 * That file was innocent. The actual cause was four hops away:
 *
 *   app/partner/workspace/page.tsx  ("use client")
 *     -> lib/provider-workspace            (imported for one pure helper, isPhotoProof)
 *       -> lib/provider-capacity-governance
 *         -> lib/provider-assignment-eligibility -> import("cloudflare:workers")
 *
 * The helper was two lines of object lookup with no server dependency of its own. It just happened
 * to LIVE in a module whose other exports talk to D1. Importing one named export does not prune the
 * rest of the graph, so a client page picked up nineteen server modules.
 *
 * Nothing local caught it. tsc resolves `cloudflare:workers` from its ambient types and is happy;
 * eslint has no view of which environment a module ends up in; the dev server loads client and
 * server code in one process, so the page rendered correctly right up to the moment CI built it.
 * Only the production build fails, and it fails five minutes after a push.
 *
 * So the rule is checked here, where it costs a second: walk the import graph from every client
 * module and fail if a server-only specifier is reachable. The fix is never to externalise the
 * specifier — it is to move the pure thing the client actually wanted into a module of its own, as
 * lib/care-proof-photo-claims.ts and lib/taxi-ride-channels.ts both do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = execFileSync("git", ["ls-files", "app", "lib", "worker", "components"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

/* Specifiers that exist only in the Workers runtime. Reaching one from the browser is the bug. */
const SERVER_ONLY = ["cloudflare:workers", "node:fs", "node:crypto", "node:path", "node:sqlite"];

/*
 * Detection looks for the specifier as a QUOTED STRING ANYWHERE in the file, not only in an import
 * the bundler can see. Assigning it to a variable first —
 *
 *   const specifier = "cloudflare:workers"; await import(specifier);
 *
 * — makes the specifier invisible to static analysis, so the build stops complaining. It does not
 * stop the module graph reaching the browser; it only stops anyone being told. A check that matched
 * the bundler's own view exactly would be blinded by the same trick, which would make this file
 * worthless precisely when it matters. So: if a client component can reach a file that so much as
 * names a Workers built-in, that is the finding.
 */
const NAMES_SERVER_ONLY = (source) =>
  SERVER_ONLY.find((s) => source.includes(`"${s}"`) || source.includes(`'${s}'`)) ?? null;

/*
 * Two things this parser has to get right, both learned the hard way while writing it:
 *
 * 1. This codebase writes imports without spaces — `import{a,b}from"./c"` — so a pattern that
 *    expects whitespace before `from` silently matches nothing and the test passes while seeing no
 *    edges at all.
 *
 * 2. `import type` is ERASED before bundling, so it is not an edge. That is not a detail, it is the
 *    convention the whole app is built on: 62 `lib/*-client.ts` shims call their route over fetch
 *    and take `import type{Foo}from"./the-server-module"` for the shape alone. Following those
 *    would report every one of them as a violation while the build is perfectly green.
 *
 * GRAPH-2 pins both, because either mistake turns this file into a test that can never fail.
 */
const FROM = /(?:^|[\s;}])((?:import|export)[^;'"]{0,400}?)from\s*["']([^"']+)["']/gm;
const BARE = /(?:^|[\s;}])import\s*["']([^"']+)["']/gm;
const DYNAMIC = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Type-only clauses carry no runtime import: `import type{X}from"y"` and `export type{X}from"y"`. */
const TYPE_ONLY = /^(?:import|export)\s+type\b/;

const specifiers = (source) => [
  ...[...source.matchAll(FROM)].filter((m) => !TYPE_ONLY.test(m[1].trim())).map((m) => m[2]),
  ...[...source.matchAll(BARE)].map((m) => m[1]),
  ...[...source.matchAll(DYNAMIC)].map((m) => m[1]),
];

function resolve(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [".ts", ".tsx", ".js", ".jsx"].map((e) => base + e)
    .concat([path.join(base, "index.ts"), path.join(base, "index.tsx")]);
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const read = (abs) => readFileSync(abs, "utf8");
const isClientModule = (source) => /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test(source);

const CLIENT_MODULES = SOURCE.filter((f) => isClientModule(read(path.join(ROOT, f))));

/** Breadth-first from one client module; returns the import chain to a server-only specifier, or null. */
function chainToServerOnly(entry) {
  const start = path.join(ROOT, entry);
  const cameFrom = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    const found = NAMES_SERVER_ONLY(read(file));
    if (found) {
      const chain = [];
      for (let at = file; at; at = cameFrom.get(at)) chain.unshift(path.relative(ROOT, at));
      return `${chain.join("\n       -> ")}\n       -> ${found}`;
    }
    for (const spec of specifiers(read(file))) {
      const next = resolve(spec, file);
      if (next && !cameFrom.has(next)) { cameFrom.set(next, file); queue.push(next); }
    }
  }
  return null;
}

test("GRAPH-1: no client component can reach server-only code through its imports", () => {
  const reaching = CLIENT_MODULES.map((f) => chainToServerOnly(f)).filter(Boolean);
  assert.deepEqual(reaching, [],
    `these client components pull server-only modules into the browser bundle, which fails the production build:\n\n    ${reaching.join("\n\n    ")}\n\n  Move the pure value the client needs into its own import-free module.`);
});

test("GRAPH-2: the walk actually parses this codebase's import style", () => {
  /* A regex that matched nothing would make GRAPH-1 pass for ever. Prove both halves see real edges. */
  assert.ok(CLIENT_MODULES.length > 50,
    `expected many client components, found ${CLIENT_MODULES.length} — the directive scan is not reaching them`);

  const spaced = specifiers(`import { a } from "./x";`);
  const tight = specifiers(`import{a,b}from"./y";`);
  assert.deepEqual(spaced, ["./x"], "failed to parse a spaced import");
  assert.deepEqual(tight, ["./y"], "failed to parse this repo's space-free import style");

  /* Type-only clauses are erased before bundling, so they must NOT count as edges... */
  assert.deepEqual(specifiers(`import type{A}from"./t";`), [], "followed a type-only import");
  assert.deepEqual(specifiers(`export type { A } from "./t";`), [], "followed a type-only re-export");
  /* ...but a clause that also brings a VALUE across is a real edge, inline `type` modifier or not. */
  assert.deepEqual(specifiers(`import{type A,run}from"./v";`), ["./v"], "dropped a real value import");
  assert.deepEqual(specifiers(`import"./side-effect";`), ["./side-effect"], "dropped a side-effect import");
  assert.deepEqual(specifiers(`await import("./lazy")`), ["./lazy"], "dropped a dynamic import");

  /* And prove the walk crosses at least one real hop in the repo, not just the entry file. */
  const workspace = path.join(ROOT, "lib/provider-workspace.ts");
  assert.ok(specifiers(read(workspace)).some((s) => resolve(s, workspace)),
    "resolved no relative imports out of lib/provider-workspace — the resolver is not working");
});

test("GRAPH-3: the gate a client component needs lives in an import-free module", () => {
  /* The specific regression: lib/care-proof-photo-claims exists so the partner workspace page can
     read the photo-proof gate without dragging lib/provider-workspace's D1 graph along. */
  const claims = path.join(ROOT, "lib/care-proof-photo-claims.ts");
  assert.deepEqual(specifiers(read(claims)), [],
    "lib/care-proof-photo-claims must stay import-free — a client component imports it directly");
});
