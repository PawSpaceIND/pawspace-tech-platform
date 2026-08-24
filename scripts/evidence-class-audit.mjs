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
 */

import fs from "node:fs";
import path from "node:path";

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

/** Strips comments and string bodies so a path named only inside a comment is never read as an import. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
}

function specifiers(code) {
  const found = [];
  for (const match of code.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`]+)["'`]?/g)) found.push(match[1]);
  return found;
}

/**
 * Every module under a source root this file pulls in, static or dynamic. Template literals with an
 * interpolated segment are kept as a `*` prefix: `../app/api/${name}/route.ts` still tells us route
 * handlers are executed, which is the fact the class depends on.
 */
export function executedSourceModules(source) {
  const found = new Set();
  for (const raw of specifiers(codeOnly(source))) {
    const specifier = raw.replace(/\$\{[^}]*\}/g, "*");
    const normalised = specifier.replace(/^(\.\.?\/)+/, "");
    if (!new RegExp(`^(${ROOTS_ALT})/`).test(normalised)) continue;
    found.add(normalised);
  }
  return [...found].sort();
}

/** Test-local modules whose signals belong to whichever suite imports them. */
function localTestModules(source, fromFile) {
  const dir = path.dirname(fromFile);
  const found = new Set();
  for (const raw of specifiers(codeOnly(source))) {
    if (!raw.startsWith(".")) continue;
    if (!/\.(mjs|ts|js)$/.test(raw)) continue;
    const resolved = path.normalize(path.join(dir, raw.replace(/\$\{[^}]*\}/g, "*")));
    if (resolved.includes("*")) continue;
    found.add(resolved);
  }
  return [...found];
}

/** `wrangler dev --config wrangler.x.jsonc` boots a real Worker over a real D1 binding. */
function wranglerConfigs(source) {
  return [...codeOnly(source).matchAll(/["'`](wrangler\.[A-Za-z0-9._-]+\.jsonc)["'`]/g)].map(match => match[1]);
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
  const signals = { modules: new Set(), sqlite: false, localWorker: false, hosted: false };
  if (seen.has(key)) return signals;
  seen.add(key);

  let source;
  try { source = fs.readFileSync(path.join(repoRoot, key), "utf8"); } catch { return signals; }
  const code = codeOnly(source);

  for (const reached of executedSourceModules(source)) signals.modules.add(reached);
  if (/from\s*["']node:sqlite["']/.test(code) || /require\(\s*["']node:sqlite["']\s*\)/.test(code)) signals.sqlite = true;

  // A deployed origin or provider host supplied by the environment - the only way a suite here can
  // reach something it did not itself construct. A literal https:// inside a test is an assertion
  // fixture, not traffic, so it deliberately does not count.
  if (/process\.env\.(PAWSPACE_HOSTED_[A-Z_0-9]+|PAWSPACE_PROVIDER_[A-Z_0-9]+)/.test(code)) signals.hosted = true;

  for (const config of wranglerConfigs(source)) {
    signals.localWorker = true;
    const entry = wranglerEntry(config, repoRoot);
    if (entry) {
      const nested = collectSignals(entry, repoRoot, seen);
      for (const reached of nested.modules) signals.modules.add(reached);
      signals.sqlite = signals.sqlite || nested.sqlite;
    }
  }

  for (const local of localTestModules(source, key)) {
    const nested = collectSignals(local, repoRoot, seen);
    for (const reached of nested.modules) signals.modules.add(reached);
    signals.sqlite = signals.sqlite || nested.sqlite;
    signals.localWorker = signals.localWorker || nested.localWorker;
    signals.hosted = signals.hosted || nested.hosted;
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
