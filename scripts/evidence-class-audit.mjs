/**
 * Evidence-class audit.
 *
 * The suite count in this repository is not a proof score. 300 files sounds like overwhelming
 * coverage until you ask what each one actually *ran*. A file that reads `lib/x.ts` as a string and
 * asserts `/refund/` appears in it proves the word "refund" is present. It does not prove a refund is
 * gated, and it keeps passing after the gate is deleted as long as the identifier survives in a
 * comment. Both kinds of file are named `*.test.mjs` and both go green, so the aggregate number tells
 * a reader nothing about whether the product works.
 *
 * This audit sorts every suite into the four classes that actually differ in what they can catch:
 *
 *   real_execution   imports the real module AND drives it against a live SQLite/D1 database, or
 *                    boots a real Worker over a real D1 binding. Catches behaviour, persistence and
 *                    negative paths. The only class that can prove a gate refuses something.
 *   imported_unit    imports and calls the real module, no database. Catches pure logic and refusal
 *                    decisions; cannot prove anything was persisted or read back.
 *   hosted_provider  executes against a deployed origin or a real third-party provider. The only
 *                    class that can prove an integration is live.
 *   source_contract  reads source text and asserts patterns. Catches deletion of a named symbol and
 *                    nothing else. Legitimate for wiring/config invariants; never proof of behaviour.
 *
 * Classification is derived from what a file imports and executes, never from its name - a suite
 * called `*-real-d1.test.mjs` that only greps source is exactly the failure this audit exists to
 * surface. Two properties make that derivation honest, and both were added because their absence
 * misclassified real suites as source-text-only:
 *
 *   Signals are collected TRANSITIVELY through test-local modules. `uat-scheduling-...-runtime`
 *   imports no source file itself; it drives routes through `helpers/grooming-journey-harness.mjs`.
 *   Reading only the top file makes the strongest kind of suite in the repository look like the
 *   weakest kind.
 *
 *   A `wrangler dev` spawn counts as real execution, and its worker entry is followed. The four
 *   Release-CI D1 jobs boot an actual Worker against an actual D1 binding over HTTP; that is more
 *   execution than a node:sqlite shim, not less, and no import of `node:sqlite` appears anywhere in
 *   the suite that drives it.
 *
 * This remains static analysis: it cannot prove an assertion is meaningful or a branch was reached.
 * It is deliberately conservative about the facts it does report, however. A product import counts
 * only when the imported binding is called, constructed, dereferenced or wired into a Worker handler;
 * `wrangler.dev.jsonc` counts only when an actual `wrangler dev` call and a local HTTP request both
 * appear. An inert import, a config filename, or import-like text in a fixture therefore stays a source
 * contract. Runtime coverage is still required to establish which internal branches executed.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const EVIDENCE_CLASSES = ["real_execution", "imported_unit", "hosted_provider", "source_contract"];

/**
 * Names that promise executable evidence. A file carrying one of these while classifying as
 * source_contract is misleading by construction and is reported as such.
 */
const EXECUTION_CLAIMING_NAME = /(^|-)(real-d1|runtime|execution|executable|behavior|behaviour|persistence)(-|\.)/;

/**
 * Names that promise a *verdict* - that a gate is closed, that something is true or certified. Weaker
 * than claiming execution, but a source-text read cannot deliver a verdict either: `walking-gate3`
 * greps `lib/walking-*.ts` and passes whether or not a single walking booking can be created. Names
 * that already say "contract" are honest about what they are and are not counted.
 */
const VERDICT_CLAIMING_NAME = /(^|-)(gate\d+|closure|truth|proof|proven|verified|certified)(-|\.)/;
const HONEST_CONTRACT_NAME = /(source-contract|-contract)(-|\.)/;

// `e2e` is the release-preview gate, which `.github/workflows/deploy-release-preview.yml` actually
// runs - executing it is genuine execution of shipped tooling, not a source-text read.
const SOURCE_ROOTS = ["lib", "app", "worker", "scripts", "components", "e2e"];
const ROOTS_ALT = SOURCE_ROOTS.join("|");

/** Collapses near-synonym prefixes so the per-module counts read as business areas, not spelling variants. */
const MODULE_ALIASES = new Map(Object.entries({
  "pawspace": "platform", "platform": "platform", "worker": "platform", "api": "platform", "server": "platform",
  "haptik": "ai", "chat": "ai",
  "exotel": "voice", "bot": "voice", "telephony": "voice",
  "canonical": "booking", "bookings": "booking",
  "razorpay": "payments", "payment": "payments", "payout": "payments", "refund": "payments",
  "pnl": "finance", "gst": "finance", "tds": "finance", "revenue": "finance",
  "comms": "communications", "communication": "communications", "whatsapp": "communications",
  "integration": "readiness", "readiness": "readiness", "production": "readiness",
  "release": "release", "staging": "release", "deploy": "release", "closure": "release",
  "*": "multi-route",
}));

/**
 * `app/api/voice-outbound/route.ts` must bucket as "voice", not as "route" - the directory carries the
 * domain and the filename is identical for all 202 handlers.
 */
function moduleBucket(name) {
  const raw = String(name);
  const routed = /^app\/(?:api\/)?([^/]+)\/(?:route\.ts|page\.tsx)$/.exec(raw);
  const base = routed ? routed[1] : raw.replace(/^.*\//, "");
  const token = base.replace(/\.(test\.mjs|ts|tsx|mjs)$/g, "").split("-")[0] || "other";
  return MODULE_ALIASES.get(token) ?? token;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += `\${${span.expression.getText()}}${span.literal.text}`;
    return value;
  }
  return null;
}

function bindingNames(name, found = []) {
  if (ts.isIdentifier(name)) found.push(name.text);
  else for (const element of name.elements) bindingNames(element.name, found);
  return found;
}

function bindingIsExecuted(identifier) {
  const parent = identifier.parent;
  if (!parent) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isTaggedTemplateExpression(parent)) && parent.expression === identifier) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === identifier) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === identifier) return true;
  return false;
}

/** Parses real import syntax and reports only imports whose bindings are subsequently exercised. */
function moduleReferences(source) {
  const file = ts.createSourceFile("evidence.mts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references = [];
  const bindings = new Map();

  function remember(specifier, names, declarationEnd, factoryKey = null) {
    const reference = { specifier, executed: false, factoryKey };
    references.push(reference);
    for (const name of names) {
      const list = bindings.get(name) ?? [];
      list.push({ reference, declarationEnd });
      bindings.set(name, list);
    }
    return reference;
  }

  function collect(node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier) {
        const names = [];
        const clause = node.importClause;
        if (clause?.name) names.push(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) names.push(element.name.text);
        }
        remember(specifier, names, node.end);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0] && literalText(node.arguments[0]);
      if (specifier) {
        let cursor = node.parent;
        if (ts.isAwaitExpression(cursor)) cursor = cursor.parent;
        while (ts.isParenthesizedExpression(cursor)) cursor = cursor.parent;
        if (ts.isVariableDeclaration(cursor)) remember(specifier, bindingNames(cursor.name), cursor.end);
        else {
          let factoryKey = null;
          for (let owner = node.parent; owner; owner = owner.parent) {
            if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
              if (ts.isPropertyAssignment(owner.parent)) {
                const object = owner.parent.parent;
                const declaration = object && ts.isObjectLiteralExpression(object) && ts.isVariableDeclaration(object.parent) ? object.parent : null;
                if (declaration && ts.isIdentifier(declaration.name)) factoryKey = `${declaration.name.text}.${owner.parent.name.getText(file)}`;
              } else if (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) factoryKey = owner.parent.name.text;
              break;
            }
            if (ts.isFunctionDeclaration(owner)) { factoryKey = owner.name?.text ?? null; break; }
          }
          const reference = remember(specifier, [], node.end, factoryKey);
          reference.executed = Boolean(cursor && (
            ((ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor))
              && (cursor.expression.kind === ts.SyntaxKind.AwaitExpression || ts.isParenthesizedExpression(cursor.expression)))
            || ts.isCallExpression(cursor)
          ));
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const specifier = node.arguments[0] && literalText(node.arguments[0]);
      if (specifier) {
        const declaration = node.parent && ts.isVariableDeclaration(node.parent) ? node.parent : null;
        const reference = remember(specifier, declaration ? bindingNames(declaration.name) : [], declaration?.end ?? node.end);
        if (!declaration && bindingIsExecuted(node)) reference.executed = true;
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(file);

  function mark(node) {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(file).replace(/\s+/g, "");
      for (const reference of references) if (reference.factoryKey === called) reference.executed = true;
    }
    if (ts.isIdentifier(node)) {
      for (const binding of bindings.get(node.text) ?? []) {
        if (node.pos >= binding.declarationEnd && bindingIsExecuted(node)) binding.reference.executed = true;
      }
    }
    ts.forEachChild(node, mark);
  }
  mark(file);
  return references;
}

/**
 * Every module under a source root this file pulls in, static or dynamic. Template literals with an
 * interpolated segment are kept as a `*` prefix: `../app/api/${name}/route.ts` still tells us route
 * handlers are executed, which is the fact the class depends on.
 */
export function executedSourceModules(source) {
  const found = new Set();
  for (const { specifier: raw, executed } of moduleReferences(source)) {
    if (!executed) continue;
    const specifier = raw.replace(/\$\{[^}]*\}/g, "*");
    const normalised = specifier.replace(/^(\.\.?\/)+/, "");
    if (!new RegExp(`^(${ROOTS_ALT})/`).test(normalised)) continue;
    found.add(normalised);
  }
  return [...found].sort();
}

/** Product modules transpiled into a temporary executable module before dynamic import. */
function transpiledSourceModules(source) {
  if (!/\bts\.transpileModule\s*\(/.test(source) || !/\bimport\s*\(/.test(source)) return [];
  const found = new Set();
  for (const match of source.matchAll(/new URL\(["']((?:lib|app|worker|scripts|components|e2e)\/[^"']+\.(?:ts|tsx|mjs))["']/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** Test-local modules whose signals belong to whichever suite imports them. */
function localTestModules(source, fromFile) {
  const dir = path.dirname(fromFile);
  const found = new Set();
  for (const { specifier: raw, executed } of moduleReferences(source)) {
    if (!executed) continue;
    if (!raw.startsWith(".")) continue;
    if (!/\.(mjs|ts|js)$/.test(raw)) continue;
    const resolved = path.normalize(path.join(dir, raw.replace(/\$\{[^}]*\}/g, "*")));
    if (resolved.includes("*")) continue;
    found.add(resolved);
  }
  return [...found];
}

/** A Worker signal needs both a real `wrangler dev` process and traffic to its local origin. */
function workerProcessSignals(source) {
  const file = ts.createSourceFile("worker-test.mts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const configs = new Set();
  let localRequest = false;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const call = node.getText(file);
      if (/\bfetch\s*\(/.test(call) && /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/.test(call)) localRequest = true;
      const literals = [];
      for (const argument of node.arguments) {
        function strings(child) { const value = literalText(child); if (value != null) literals.push(value); else ts.forEachChild(child, strings); }
        strings(argument);
      }
      if (/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/.test(call)
          && literals.includes("wrangler") && literals.includes("dev")) {
        for (const value of literals) if (/^wrangler\.[A-Za-z0-9._-]+\.jsonc$/.test(value)) configs.add(value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { configs, localRequest };
}

/** A hosted signal is a real fetch argument dependency, not matching prose in a fixture/comment. */
function hostedProviderSignal(source) {
  const file = ts.createSourceFile("hosted-test.mts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let hosted = false;
  function environmentName(node) {
    if (!ts.isPropertyAccessExpression(node)) return null;
    const env = node.expression;
    if (!ts.isPropertyAccessExpression(env) || env.name.text !== "env") return null;
    return ts.isIdentifier(env.expression) && env.expression.text === "process" ? node.name.text : null;
  }
  function containsHostedEnvironment(node) {
    const name = environmentName(node);
    if (name && /^PAWSPACE_(HOSTED|PROVIDER)_[A-Z_0-9]+$/.test(name)) return true;
    let found = false;
    ts.forEachChild(node, child => { if (!found && containsHostedEnvironment(child)) found = true; });
    return found;
  }
  function visit(node) {
    if (hosted) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isFetch = (ts.isIdentifier(callee) && callee.text === "fetch")
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch");
      if (isFetch && node.arguments.some(containsHostedEnvironment)) { hosted = true; return; }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return hosted;
}

function wranglerEntry(configPath, repoRoot) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, configPath), "utf8").replace(/^\s*\/\/[^\n]*$/gm, "");
    const main = /"main"\s*:\s*"([^"]+)"/.exec(raw);
    return main ? path.normalize(main[1].replace(/^\.\//, "")) : null;
  } catch { return null; }
}

/** Collects every signal reachable from `file`, following test-local modules and worker entries. */
function collectSignals(file, repoRoot, seen = new Set()) {
  const key = path.normalize(file);
  const signals = { modules: new Set(), sqlite: false, localWorker: false, hosted: false, workerConfigs: new Set(), localRequest: false };
  if (seen.has(key)) return signals;
  seen.add(key);

  let source;
  try { source = fs.readFileSync(path.join(repoRoot, key), "utf8"); } catch { return signals; }
  for (const reached of executedSourceModules(source)) signals.modules.add(reached);
  for (const reached of transpiledSourceModules(source)) signals.modules.add(reached);
  if (moduleReferences(source).some(reference => reference.executed && reference.specifier === "node:sqlite")) signals.sqlite = true;

  // A deployed origin or provider host supplied by the environment - the only way a suite here can
  // reach something it did not itself construct. A literal https:// inside a test is an assertion
  // fixture, not traffic, so it deliberately does not count.
  signals.hosted = hostedProviderSignal(source);

  const worker = workerProcessSignals(source);
  for (const config of worker.configs) signals.workerConfigs.add(config);
  signals.localRequest = worker.localRequest;

  for (const local of localTestModules(source, key)) {
    const nested = collectSignals(local, repoRoot, seen);
    for (const reached of nested.modules) signals.modules.add(reached);
    signals.sqlite = signals.sqlite || nested.sqlite;
    for (const config of nested.workerConfigs) signals.workerConfigs.add(config);
    signals.localRequest = signals.localRequest || nested.localRequest;
    signals.hosted = signals.hosted || nested.hosted;
  }
  signals.localWorker = signals.workerConfigs.size > 0 && signals.localRequest;
  if (signals.localWorker) {
    for (const config of signals.workerConfigs) {
      const entry = wranglerEntry(config, repoRoot);
      if (!entry) continue;
      const nested = collectSignals(entry, repoRoot, seen);
      for (const reached of nested.modules) signals.modules.add(reached);
      signals.sqlite = signals.sqlite || nested.sqlite;
    }
  }
  return signals;
}

/**
 * Which business area a suite belongs to. Taking the alphabetically first executed module put
 * `voice-outbound-policy` under "communications" because it also imports the communication engine;
 * the suite's own name is the better signal whenever it agrees with something the suite actually
 * executes, and the most common bucket among executed modules is the fallback.
 */
function attributeModule(modules, file) {
  if (modules.length === 0) return moduleBucket(file);
  const named = moduleBucket(file);
  const buckets = modules.map(moduleBucket);
  if (buckets.includes(named)) return named;
  // A suite that sweeps `app/api/${name}/route.ts` belongs to no single area. Falling through to the
  // mode below attributed the platform-wide redaction and seed sweeps to "ai", purely because `lib/ai-*`
  // is the largest family of files they happen to touch.
  if (modules.some(entry => entry.startsWith("app/api/*"))) return "multi-route";
  const counts = new Map();
  for (const bucket of buckets) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  const [top, hits] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  // A plurality is not ownership. The demo-seed suite drives 18 named routes across every vertical and
  // landed in "ai" on a plurality of 4, which would have read as AI executable coverage it does not have.
  return hits * 2 > buckets.length ? top : "cross-area";
}

export function classifyTestFile(file, repoRoot = ".") {
  const signals = collectSignals(file, repoRoot);
  const modules = [...signals.modules].sort();
  const routesExecuted = modules.filter(path_ => /^app\/api\/.*route\.ts$/.test(path_) || path_.startsWith("app/api/*"));

  let evidenceClass = "source_contract";
  if (signals.hosted) evidenceClass = "hosted_provider";
  else if (signals.localWorker || (modules.length > 0 && signals.sqlite)) evidenceClass = "real_execution";
  else if (modules.length > 0) evidenceClass = "imported_unit";

  return {
    file: path.normalize(file),
    evidenceClass,
    module: attributeModule(modules, file),
    modulesExecuted: modules.length,
    routeHandlersExecuted: routesExecuted.length,
    database: signals.sqlite || signals.localWorker,
    localWorker: signals.localWorker,
    misleadingName: evidenceClass === "source_contract" && EXECUTION_CLAIMING_NAME.test(path.basename(file)),
    overclaimingName: evidenceClass === "source_contract"
      && VERDICT_CLAIMING_NAME.test(path.basename(file))
      && !HONEST_CONTRACT_NAME.test(path.basename(file)),
  };
}

/**
 * The audit's own guard suite is built entirely from synthetic fixture strings - `wrangler dev`,
 * `PAWSPACE_HOSTED_BASE_URL`, route imports - written to be classified, not executed. Counting it
 * would let the audit inflate its own numbers.
 */
const SELF = "evidence-class-audit.test.mjs";

export function auditEvidenceClasses(testDir = "tests", repoRoot = ".") {
  return fs.readdirSync(path.join(repoRoot, testDir))
    .filter(name => name.endsWith(".test.mjs") && name !== SELF).sort()
    .map(name => classifyTestFile(path.join(testDir, name), repoRoot));
}

export function summariseEvidence(rows) {
  const byClass = Object.fromEntries(EVIDENCE_CLASSES.map(name => [name, 0]));
  const byModule = new Map();
  for (const row of rows) {
    byClass[row.evidenceClass] += 1;
    const bucket = byModule.get(row.module) ?? Object.fromEntries([...EVIDENCE_CLASSES.map(name => [name, 0]), ["total", 0], ["routes", 0]]);
    bucket[row.evidenceClass] += 1;
    bucket.total += 1;
    bucket.routes += row.routeHandlersExecuted;
    byModule.set(row.module, bucket);
  }
  return {
    total: rows.length,
    byClass,
    localWorkerSuites: rows.filter(row => row.localWorker).map(row => row.file),
    misleading: rows.filter(row => row.misleadingName).map(row => row.file),
    overclaiming: rows.filter(row => row.overclaimingName).map(row => row.file),
    byModule: [...byModule.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])),
  };
}

export function markdownReport(summary) {
  const lines = [];
  lines.push(`Suites classified: **${summary.total}**`, "");
  lines.push("| evidence class | suites | share |", "| --- | --- | --- |");
  for (const name of EVIDENCE_CLASSES) {
    const count = summary.byClass[name];
    lines.push(`| ${name} | ${count} | ${summary.total ? Math.round((count / summary.total) * 100) : 0}% |`);
  }
  lines.push("", `Real-Worker (wrangler dev over a real D1 binding) suites: **${summary.localWorkerSuites.length}** - ${summary.localWorkerSuites.join(", ") || "none"}`);
  lines.push("", `Misleadingly named suites (name claims execution, file only reads source): **${summary.misleading.length}**${summary.misleading.length ? ` - ${summary.misleading.join(", ")}` : ""}`);
  lines.push("", `Verdict-claiming source-text suites (name claims a gate/closure/truth): **${summary.overclaiming.length}**`);
  for (const file of summary.overclaiming) lines.push(`  - ${file}`);
  lines.push("", "| module | suites | real_execution | imported_unit | hosted_provider | source_contract | route handlers executed |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, bucket] of summary.byModule) {
    lines.push(`| ${name} | ${bucket.total} | ${bucket.real_execution} | ${bucket.imported_unit} | ${bucket.hosted_provider} | ${bucket.source_contract} | ${bucket.routes} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("evidence-class-audit.mjs")) {
  const rows = auditEvidenceClasses("tests", ".");
  const summary = summariseEvidence(rows);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
  else console.log(markdownReport(summary));
}
