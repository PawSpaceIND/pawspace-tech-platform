/*
 * "use client" only counts as the FIRST statement in a file.
 *
 * Put an import above it and Next.js stops treating the module as a client component: the directive
 * is just a string expression in the middle of a module, silently ignored. Every hook in the file
 * then fails at runtime.
 *
 * This is a real near-miss, not a hypothetical. Adding one shared import to three onboarding pages
 * prepended it to line 1, which pushed the directive to line 2 on all three. Nothing caught it —
 *
 *   tsc          a string expression before an import is perfectly legal TypeScript
 *   eslint       passed, 0 errors
 *   the dev server  tolerated it, so a browser check of the page still looked fine
 *
 * — and three pages would have shipped as broken server components. A review bot caught it.
 *
 * The check is deliberately whole-repo rather than scoped to changed files: the failure mode is
 * "somebody adds an import to the top of an existing client component", which can happen to any of
 * them, and the scan is cheap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = execFileSync("git", ["ls-files", "app", "lib", "worker", "components"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

const DIRECTIVE = /["']use (client|server)["']/;
/* Leading comments and blank lines are allowed before a directive — only STATEMENTS are not. */
const LEADING_TRIVIA = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*/;

test("DIRECTIVE-1: every use client / use server directive is the first statement in its file", () => {
  const misplaced = [];
  for (const file of SOURCE) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    if (!DIRECTIVE.test(source)) continue;
    const body = source.replace(LEADING_TRIVIA, "");
    if (/^["']use (client|server)["'];?/.test(body)) continue;
    // The directive exists but does not lead: report what pushed it down.
    const firstStatement = body.split("\n").find((line) => line.trim()) ?? "";
    misplaced.push(`${file}  <- preceded by: ${firstStatement.trim().slice(0, 70)}`);
  }
  assert.deepEqual(misplaced, [],
    `these declare a directive that Next.js will ignore, so their hooks fail at runtime:\n  ${misplaced.join("\n  ")}`);
});

test("DIRECTIVE-2: the check actually looks at the files that matter", () => {
  /* A scan that silently matched nothing would pass for ever. */
  const withDirective = SOURCE.filter((f) => DIRECTIVE.test(readFileSync(path.join(ROOT, f), "utf8")));
  assert.ok(withDirective.length > 50,
    `expected the app to be full of client components, found ${withDirective.length} — the scan is probably not reaching them`);
});
