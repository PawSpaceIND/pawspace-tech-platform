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
import { dirname, join, resolve, relative, isAbsolute, sep, win32 } from "node:path";
import ts from "typescript";

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
/* Lowered from 165 once the helper clause above stopped counting eleven harness-driven suites as
 * static and the launch-pass tests that only read source were converted to execute their modules. */
/* 160, not 156: resume-voice-uat, verify-voice-sale, voice-uat-evidence and voice-substantive-reply
 * run the voice UAT scripts they cover (scripts/*.mjs), not lib/ or app/ modules, so this ratchet counts them as static
 * even though they execute the code under test. */
/* 160 -> 158: native Wrangler drivers were previously misclassified. The combined candidate
 * measured 161 before tracing spawn -> config.main -> runtime product imports: the newly added
 * financial-workforce driver and existing booking-fanout / scheduling-rules drivers account for
 * all three corrected files. This is a classifier correction, not three newly converted tests. */
const STATIC_FILE_BUDGET = 158;

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

/* A test that drives real routes through a shared harness in tests/helpers/ is executing product
 * code just as surely as one that imports the module itself - tests/helpers/grooming-journey-harness
 * runs the actual grooming routes against a real database, and its callers named no lib/ or app/ path
 * of their own, so they were counted static. Same reasoning as the LIB_LOADER clause above: follow
 * the helper and ask whether IT executes. One level deep is enough for every helper in the tree, and
 * a missing helper simply does not count. */
const HELPER_IMPORT = /from\s*["'`](\.\/helpers\/[a-z0-9.-]+\.mjs)["'`]/g;
const helperExecutes = (src) => {
  for (const match of src.matchAll(HELPER_IMPORT)) {
    try {
      const helper = readFileSync(join(TESTS_DIR, match[1].replace("./", "")), "utf8");
      if (STATIC_IMPORT.test(helper) || HARNESS.test(helper) || LIB_LOADER.test(helper) ||
          ((LOADER.test(helper) || TRANSPILE.test(helper)) && PRODUCT_PATH.test(helper))) return true;
    } catch { /* a helper that is not there cannot be executing anything */ }
  }
  return false;
};

/* Follow the native-worker execution edge, rather than accepting the words "wrangler" or
 * a config filename anywhere in source. This remains a static classifier of executable tests,
 * not proof that a test passed. Scope-aware symbols tie spawn to node:child_process and an args
 * variable to its const declaration. Unsupported commands/configs fail closed. */
const nativePathStyle = { sep, isAbsolute };
const relativePathIsInside = (value, style = nativePathStyle) =>
  value.split(style.sep)[0] !== ".." && !style.isAbsolute(value);
const relativePathIsProduct = (value, style = nativePathStyle) => {
  const parts = value.split(style.sep);
  return parts.length > 1 && ["lib", "app"].includes(parts[0]);
};

function nativeWorkerExecutes(src, root = dirname(TESTS_DIR), read = (path) => readFileSync(path, "utf8")) {
  if (!src.includes("child_process")) return false;
  const fileName = resolve(root, "tests/classification-input.mjs").split(sep).join("/");
  const source = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const program = ts.createProgram([fileName], { allowJs: true, noResolve: true, noLib: true }, {
    getSourceFile: (name) => name === fileName ? source : undefined,
    getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => root.split(sep).join("/"),
    getDirectories: () => [], fileExists: (name) => name === fileName,
    readFile: (name) => name === fileName ? src : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  });
  const checker = program.getTypeChecker();
  const literal = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const insideRoot = (path) => relativePathIsInside(relative(root, path));
  const runtimeImport = (node) => ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly &&
    (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) ||
      !!node.importClause.name || node.importClause.namedBindings.elements.some((item) => !item.isTypeOnly));
  const visited = new Set();
  function workerLoadsProduct(path) {
    if (!insideRoot(path) || visited.has(path)) return false;
    visited.add(path);
    let contents;
    try { contents = read(path); } catch { return false; }
    const ast = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!runtimeImport(statement)) continue;
      const specifier = literal(statement.moduleSpecifier);
      if (!specifier?.startsWith(".")) continue;
      const base = resolve(dirname(path), specifier);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts")]) {
        if (!insideRoot(candidate)) continue;
        try { read(candidate); } catch { continue; }
        if (relativePathIsProduct(relative(root, candidate))) return true;
        if (workerLoadsProduct(candidate)) return true;
      }
    }
    return false;
  }
  function isSpawn(node) {
    if (!ts.isIdentifier(node)) return false;
    const declarations = checker.getSymbolAtLocation(node)?.declarations;
    if (declarations?.length !== 1) return false;
    const decl = declarations[0];
    return ts.isImportSpecifier(decl) && (decl.propertyName?.text ?? decl.name.text) === "spawn" &&
      ["node:child_process", "child_process"].includes(literal(decl.parent.parent.parent.moduleSpecifier));
  }
  const nodeCommand = (node) => ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "process" &&
    !checker.getSymbolAtLocation(node.expression)?.declarations?.length && node.name.text === "execPath";
  const npxCommand = (node) => ["npx", "npx.cmd"].includes(literal(node)) ||
    (ts.isConditionalExpression(node) && npxCommand(node.whenTrue) && npxCommand(node.whenFalse));
  function invocationExecutes(node) {
    if (!ts.isCallExpression(node) || !isSpawn(node.expression) || node.arguments.length < 2) return false;
    const [command, suppliedArgs, options] = node.arguments;
    // A changed cwd makes relative config resolution ambiguous; do not guess.
    if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some((property) =>
      ts.isSpreadAssignment(property) || property.name?.getText(source).replace(/["']/g, "") === "cwd"))) return false;
    let args = suppliedArgs;
    if (ts.isIdentifier(args)) {
      const declarations = checker.getSymbolAtLocation(args)?.declarations;
      if (declarations?.length !== 1) return false;
      const decl = declarations[0];
      if (!ts.isVariableDeclaration(decl) || !(decl.parent.flags & ts.NodeFlags.Const) || decl.pos >= node.pos) return false;
      args = decl.initializer;
    }
    if (!args || !ts.isArrayLiteralExpression(args)) return false;
    const values = args.elements.map(literal);
    if (!((nodeCommand(command) && values[0] === "node_modules/wrangler/bin/wrangler.js") ||
      (npxCommand(command) && values[0] === "wrangler"))) return false;
    if (values[1] !== "dev" || values[2] !== "--config" || !values[3]?.match(/\.jsonc?$/)) return false;
    const configPath = resolve(root, values[3]);
    if (!insideRoot(configPath)) return false;
    try {
      const parsed = ts.parseConfigFileTextToJson(configPath, read(configPath));
      if (parsed.error || typeof parsed.config?.main !== "string") return false;
      return workerLoadsProduct(resolve(dirname(configPath), parsed.config.main));
    } catch { return false; }
  }
  let found = false;
  function visit(node) { if (invocationExecutes(node)) found = true; if (!found) ts.forEachChild(node, visit); }
  visit(source);
  return found;
}

const executes = (src) =>
  STATIC_IMPORT.test(src) || HARNESS.test(src) || LIB_LOADER.test(src) ||
  ((LOADER.test(src) || TRANSPILE.test(src)) && PRODUCT_PATH.test(src)) ||
  helperExecutes(src) || nativeWorkerExecutes(src);

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
const META_TESTS = new Set([
  "test-suite-executes-code.test.mjs",
  "schema-column-reference-contract.test.mjs",
  "customer-vertical-routes.test.mjs",
  "use-client-directive-placement.test.mjs",
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

const nativeFixtureRoot = resolve('/virtual-native-classifier');
const nativeFixtureFiles = {
  'wrangler.proof.jsonc': '{ // local worker\n "main": "tests/proof-worker.ts", }',
  'tests/proof-worker.ts': 'import { run } from "../lib/proof"; export default { fetch: run };',
  'lib/proof.ts': 'export const run = () => new Response("ok");',
};
const nativeInvocation = 'spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "wrangler.proof.jsonc", "--local"]);';
const nativeImport = 'import { spawn } from "node:child_process";\n';
function classifyNative(source, overrides = {}) {
  const files = { ...nativeFixtureFiles, ...overrides };
  return nativeWorkerExecutes(source, nativeFixtureRoot, (path) => {
    const contents = files[relative(nativeFixtureRoot, path)];
    if (typeof contents !== 'string') throw new Error('fixture does not exist');
    return contents;
  });
}

test('native classifier follows literal spawn, JSONC config, and real worker imports', () => {
  assert.equal(classifyNative(nativeImport + nativeInvocation), true);
  assert.equal(classifyNative(nativeImport + `const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "wrangler.proof.jsonc"];
    args.push("--local"); spawn(process.execPath, args);`), true);
  assert.equal(classifyNative(nativeImport.replace('{ spawn }', '{ spawn as launch }') + nativeInvocation.replace('spawn(', 'launch(')), true);
  assert.equal(classifyNative(nativeImport + nativeInvocation.replace('process.execPath', 'process.platform === "win32" ? "npx.cmd" : "npx"').replace('node_modules/wrangler/bin/wrangler.js', 'wrangler')), true);
  assert.equal(classifyNative(nativeImport + nativeInvocation, {
    'tests/proof-worker.ts': 'import { run } from "./helper.mjs";',
    'tests/helper.mjs': 'import { run } from "../app/api/proof/route";',
    'app/api/proof/route.ts': 'export const run = () => new Response("ok");',
  }), true);
});

test('native classifier rejects source text, unused references, and unrelated child processes', () => {
  const rejected = [
    '// ' + nativeImport + '// ' + nativeInvocation,
    `const source = ${JSON.stringify(nativeImport + nativeInvocation)};`,
    nativeImport + 'const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "wrangler.proof.jsonc"];',
    nativeImport + 'readFileSync("wrangler.proof.jsonc"); spawn(process.execPath, ["other-script.mjs"]);',
    nativeInvocation,
    'const spawn = () => {}; ' + nativeInvocation,
    nativeImport + 'function test(spawn) { ' + nativeInvocation + ' }',
    nativeImport + 'function test(process) { ' + nativeInvocation + ' }',
    nativeImport + 'const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "wrangler.proof.jsonc"]; function test(args) { spawn(process.execPath, args); }',
    nativeImport.replace('node:child_process', './fake-process.mjs') + nativeInvocation,
    nativeImport + nativeInvocation.replace('process.execPath', '"echo"'),
    nativeImport + nativeInvocation.replace('"dev"', '"deploy"'),
    nativeImport + nativeInvocation.replace('"wrangler.proof.jsonc"', 'configPath'),
    nativeImport + nativeInvocation.replace('"wrangler.proof.jsonc"', '"../outside.jsonc"'),
    nativeImport + nativeInvocation.replace(']);', '], { cwd: "elsewhere" });'),
  ];
  for (const source of rejected) assert.equal(classifyNative(source), false, source);
});

test('native classifier requires an existing runtime product import and fails closed on broken edges', () => {
  const rejected = [
    { 'wrangler.proof.jsonc': null },
    { 'wrangler.proof.jsonc': '{ broken json' },
    { 'wrangler.proof.jsonc': '{}' },
    { 'wrangler.proof.jsonc': '{"main":"../outside.ts"}' },
    { 'tests/proof-worker.ts': null },
    { 'tests/proof-worker.ts': 'const text = \'import { run } from "../lib/proof"\';' },
    { 'tests/proof-worker.ts': 'import type { Run } from "../lib/proof";' },
    { 'tests/proof-worker.ts': 'import { type Run } from "../lib/proof";' },
    { 'lib/proof.ts': null },
    { 'tests/proof-worker.ts': 'import "./cycle.mjs";', 'tests/cycle.mjs': 'import "./proof-worker.ts";' },
  ];
  for (const files of rejected) assert.equal(classifyNative(nativeImport + nativeInvocation, files), false, JSON.stringify(files));
});

test('native classifier recognizes the actual native D1 drivers without executing infrastructure', () => {
  for (const name of [
    'booking-fanout-atomicity-real-d1.test.mjs',
    'financial-workforce-integrity-real-d1.test.mjs',
    'scheduling-rules-authorization-real-d1.test.mjs',
  ]) assert.equal(nativeWorkerExecutes(readFileSync(join(TESTS_DIR, name), 'utf8')), true, name);
});


test('native path classification preserves platform separators and rejects traversal or other drives', () => {
  const root = String.raw`C:\repo`;
  for (const file of [String.raw`C:\repo\lib\proof.ts`, String.raw`C:\repo\app\api\proof.ts`]) {
    const path = win32.relative(root, file);
    assert.equal(relativePathIsInside(path, win32), true);
    assert.equal(relativePathIsProduct(path, win32), true);
  }
  for (const file of [String.raw`C:\outside\lib\proof.ts`, String.raw`D:\repo\lib\proof.ts`]) {
    const path = win32.relative(root, file);
    assert.equal(relativePathIsInside(path, win32), false);
    assert.equal(relativePathIsProduct(path, win32), false);
  }
  assert.equal(relativePathIsProduct(win32.relative(root, String.raw`C:\repo\tests\lib\proof.ts`), win32), false);
  assert.equal(relativePathIsInside('../lib/proof.ts'), false);
  assert.equal(relativePathIsProduct('lib/proof.ts'), true);
  // A backslash is a valid filename character on POSIX, not a directory separator.
  if (sep === '/') assert.equal(relativePathIsProduct(String.raw`lib\proof.ts`), false);
});
