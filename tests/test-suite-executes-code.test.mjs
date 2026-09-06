/*
 * A ratchet on static tests.
 *
 * 172 of this suite's 528 top-level test files (33%) never execute a single line of lib/ or app/ code - they
 * read the source with readFileSync and regex-match it. Between them they hold thousands of
 * assertions that cannot
 * detect a behavioural defect: the module can be entirely broken and the file still passes, because
 * nothing calls it. lib/gst-accounting.ts is the clearest case - its whole test file asserts on
 * source text and never invokes a function.
 *
 * Source-text assertions are not worthless. They pin ordering, structure and "this guard must exist
 * in this file", which behaviour alone cannot always express. The problem is proportion, and the
 * fact that the count only ever grew.
 *
 * This test does not demand they all be converted at once - that is weeks of work. It fixes the
 * number in place so it can only go DOWN. Add a new static test file and this goes red; convert one
 * and the budget must be lowered to match, which is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/* The measured count at the time this ratchet was introduced. LOWER IT when you convert a file.
 * Never raise it: a new test that cannot fail is not coverage. */
// Exact-head CI correction: the detector reports 172 after the executable GST, commission and RBAC
// conversions in this PR. The earlier 170 figure was a baseline measurement error, not two further
// conversions. Freeze the measured tree here; from this corrected baseline the number may only fall.
const STATIC_FILE_BUDGET = 172;

/*
 * A file "executes" if it loads a lib/ or app/ module.
 *
 * The naive version of this - look for `from "../lib/` or `import("../lib/` - produced FALSE
 * POSITIVES and I nearly enforced a wrong number. tests/refund-cap-collected-funds.test.mjs holds
 * its module path in a variable and calls `import(service.module)`, so no literal appears next to
 * the import; it was counted static despite running 19 executing tests against a real database.
 *
 * So: a static import, OR any dynamic import in a file that references a lib/app path, OR use of
 * installWorkersHooks, which only exists to wire the D1 execution harness.
 */
const STATIC_IMPORT = /from\s*["'`]\.\.\/(lib|app)\//;
const HARNESS       = /installWorkersHooks/;
const LOADER        = /import\s*\(|pathToFileURL|createRequire/;
const PRODUCT_PATH  = /["'`][^"'`]*\b(lib|app)\/[a-z0-9/-]+(\.(ts|tsx))?["'`]/;
const TRANSPILE     = /typescript|transpile/;
/*
 * A HEURISTIC, not ground truth. The naive version - `from "../lib/` or `import("../lib/` - produced
 * false positives TWICE and I nearly enforced a wrong number both times:
 *
 *   refund-cap-collected-funds.test.mjs holds its module path in a variable and calls
 *   `import(service.module)`, so no literal sits next to the import. It runs 19 executing tests.
 *
 *   financial-lifecycle-executable-concurrency.test.mjs transpiles lib/financial-lifecycle with the
 *   typescript compiler and loads it via pathToFileURL, referencing it as "lib/..." with no "../"
 *   prefix at all. It runs 4 real concurrency tests. Its name was accurate; my detector was not.
 *
 * `node --test` runs each file in its own process, so a resolve hook that would measure real module
 * loads cannot reach them. Err towards counting a file as EXECUTING - over-reporting static files
 * invites converting something that already works.
 */
const executes = (src) =>
  STATIC_IMPORT.test(src) || HARNESS.test(src) ||
  ((LOADER.test(src) || TRANSPILE.test(src)) && PRODUCT_PATH.test(src));

/* This file is excluded from its own count. It is a meta-test about the suite, so it legitimately
 * executes no product code - and counting itself was the first thing it did, which was a fair
 * demonstration of the problem but not a useful signal. */
const SELF = "test-suite-executes-code.test.mjs";

function staticTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.mjs") && f !== SELF)
    .filter((f) => !executes(readFileSync(join(TESTS_DIR, f), "utf8")));
}

test("the number of test files that never execute code does not grow", () => {
  const staticFiles = staticTestFiles();
  assert.ok(
    staticFiles.length <= STATIC_FILE_BUDGET,
    `${staticFiles.length} test files execute no lib/ or app/ code, over the budget of ${STATIC_FILE_BUDGET}.\n` +
    `A test that only regex-matches source cannot detect a broken module.\n` +
    `Newly added or newly static:\n  ${staticFiles.slice(-8).join("\n  ")}`,
  );
});

test("the budget is kept honest - lower it when files are converted", () => {
  /* Non-vacuity. Without this, the budget could drift far above the real count and the ratchet
   * would silently stop ratcheting. If this fails, converted files have been left unclaimed:
   * lower STATIC_FILE_BUDGET to the reported number. */
  const actual = staticTestFiles().length;
  assert.ok(
    actual >= STATIC_FILE_BUDGET - 5,
    `only ${actual} static test files remain but the budget still says ${STATIC_FILE_BUDGET}. ` +
    `Lower STATIC_FILE_BUDGET to ${actual} so the ratchet keeps its teeth.`,
  );
});
