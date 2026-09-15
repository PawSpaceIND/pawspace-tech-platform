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
// Exact-head CI correction: the detector reported 172 after the executable GST, commission and RBAC
// conversions. The earlier 170 figure was a baseline measurement error, not two further conversions.
//
// 172 -> 170: ai-web-chat-source-contract and uat-scheduling-reservation-ownership were converted
// to execute the real handlers (#559).
//
// 170 -> 169: meta-whatsapp-webhook converted to execute verifyMetaWhatsAppSignature with real
// HMACs. Sabotage-verified, and the measurement is the argument for the whole exercise: bypassing
// the digest comparison entirely leaves all THREE of that file's original regexes satisfied, while
// the executed version reports FORGERY ACCEPTED. See the file header.
//
// All three sabotages leave the OLD regex assertions satisfied - the point being that the previous
// versions could not have caught the regression the new ones do.
//
// 169 -> 164: Work Order 02. The five Grooming and Training source-text suites now execute the real
// modules against a real database: grooming-customer-integrity and grooming-maps drive the
// scheduling, booking, service-location, GPS route and Routes-adapter paths; training-customer-wiring,
// training-programme and training-session-lifecycle drive the quote, programme and session lifecycle
// modules and their routes. Sabotage-verified in the PR: each converted suite goes red when its
// guard is disabled behind the very string the old regex matched, while the old file stays green.
/* 165, not 164: schema-read-coverage.test.mjs is deliberately static. It is the read-side twin of
 * schema-column-reference-contract.test.mjs above — it reads source to find routes that SELECT from
 * a table nothing on their import path creates, which is precisely the defect that executing a
 * module cannot reveal, because the failing query only runs against a cold database. */
/* 165 -> 163: payroll-engine and incentive-engine converted. Both were pure source-scanners over the
 * two modules that decide what people are PAID - every assertion was
 * `assert.match(readFileSync("lib/<engine>.ts"), /some string/)`, so the whole of both files passed
 * against an engine that pays on pipeline revenue, pays the same approved incentive twice, ignores a
 * configured cap, or lets the person who created a payroll run approve it. They now run the real
 * engines against a real SQLite-backed D1 and assert NUMBERS. Twelve sabotages were measured: each
 * one turns the converted file RED while leaving every original regex satisfied. */
/* 163 -> 162: people-attendance-leave converted. All eight of its tests were
 * `assert.match(readFileSync("lib/attendance-leave.ts"), /some string/)`, so the file passed against an
 * engine that returns the wrong leave balance, fabricates hours for a day with no check-out, writes
 * straight through a locked payroll period, or has had its self-scope check deleted - every refusal
 * STRING would still have been in the source. It now runs the real engine and the real route over a
 * real SQLite-backed D1 and asserts the balances, the minutes and the status codes. */
const STATIC_FILE_BUDGET = 162;

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
/* tests/helpers/ts-module-loader.mjs transpiles a lib/ module and its transitive dependencies and
 * imports the result. A file calling it is executing production code by definition - the helper does
 * nothing else - and it names the module bare ("provider-workspace"), with no lib/ prefix for
 * PRODUCT_PATH to match. Without this clause the loader's own users are counted static, which is the
 * opposite of what this ratchet exists to encourage. */
const LIB_LOADER    = /importLibModule\s*\(/;

const executes = (src) =>
  STATIC_IMPORT.test(src) || HARNESS.test(src) || LIB_LOADER.test(src) ||
  ((LOADER.test(src) || TRANSPILE.test(src)) && PRODUCT_PATH.test(src));

/*
 * Excluded from the count. These are meta-tests ABOUT the source - reading it is the whole job, not
 * a substitute for exercising it - so they can never be "converted" and must not consume budget
 * that exists to pressure product tests. The bar for adding one is high: it has to check something
 * no executing test can reach, and it has to be able to FAIL.
 *
 *   test-suite-executes-code.test.mjs   this file. Counting itself was the first thing it did,
 *                                       which was a fair demonstration but not a useful signal.
 *
 *   schema-column-reference-contract    checks that every column named in a SQL string exists in
 *   .test.mjs                           the schema that creates its table. A column name inside a
 *                                       string literal is invisible to the build, to tsc and to
 *                                       every executing test - three real defects reached main
 *                                       through exactly that gap. Executing the module is what
 *                                       CANNOT catch it: the bad line only runs on a rare branch.
 *
 *   use-client-directive-placement       checks that "use client" is the FIRST statement in its
 *   .test.mjs                            file. Put an import above it and Next.js silently ignores
 *                                        the directive, so the module ships as a server component
 *                                        and every hook in it fails. Executing the module is what
 *                                        CANNOT catch it - the directive is just a string
 *                                        expression, legal to tsc, clean to eslint, and tolerated
 *                                        by the dev server, so even a browser check of the page
 *                                        looks fine. It reached three pages at once before a review
 *                                        bot caught it, and it fails: swapping the two lines back
 *                                        turns it red and names the import that pushed it down.
 *
 *   customer-vertical-routes            checks that every vertical resolves at its own path. There
 *   .test.mjs                           is nothing to execute: /grooming 404'd because app/grooming
 *                                       held only manage/page.tsx, and a page that does not exist
 *                                       exports nothing to import. tsc, lint and every module test
 *                                       stayed green the whole time it was down. The filesystem is
 *                                       the only witness, and it fails - deleting the page again
 *                                       turns all three of its tests red.
 */
// Tests whose subject IS the shape of the codebase: there is no lib/app function to execute,
// because the property under test is a fact about the file tree itself. Exempt, not budgeted.
const META_TESTS = new Set([
  "test-suite-executes-code.test.mjs",
  "schema-column-reference-contract.test.mjs",
  "customer-vertical-routes.test.mjs",
  "use-client-directive-placement.test.mjs",
  // Same kind as customer-vertical-routes above: it asserts which page routes are linked from
  // somewhere in app/lib/worker, which is a property of the tree, not of any function. The
  // behaviour behind it IS executed - tests/w2d-hub-links-render.test.mjs renders every hub for
  // real roles and asserts the links appear and disappear.
  "w2d-route-reachability.test.mjs",
]);

function staticTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.mjs") && !META_TESTS.has(f))
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
