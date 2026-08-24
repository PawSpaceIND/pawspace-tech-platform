/**
 * Guards the evidence-class audit itself.
 *
 * The audit exists to stop the repository claiming proof it does not have, so the audit is the one
 * thing that must not be trusted on its own say-so. Every class is proved on a synthetic suite whose
 * only distinguishing feature is the thing being classified, and each classification is also proved to
 * FAIL when that feature is removed - otherwise a classifier that returned "real_execution" for
 * everything would pass a positive-only test.
 *
 * The two transitive cases are here because their absence misclassified the strongest suites in the
 * repository as the weakest: a suite that drives routes through a helper imports no source file
 * itself, and a suite that boots `wrangler dev` over a real D1 binding imports no node:sqlite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTestFile, auditEvidenceClasses, summariseEvidence, executedSourceModules } from "../scripts/evidence-class-audit.mjs";

function sandbox(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-audit-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

test("a suite that only reads source text classifies as source_contract", () => {
  const root = sandbox({
    "tests/a.test.mjs": `import fs from "node:fs";\nconst src = fs.readFileSync("lib/refunds.ts", "utf8");\nassert.match(src, /refund/);\n`,
  });
  const row = classifyTestFile("tests/a.test.mjs", root);
  assert.equal(row.evidenceClass, "source_contract");
  assert.equal(row.modulesExecuted, 0);
  assert.equal(row.database, false);
});

test("hosted-provider text inside a string is not classified as hosted traffic", () => {
  const root = sandbox({
    "tests/a.test.mjs": `const src = 'fetch(process.env.PAWSPACE_HOSTED_BASE_URL)';\nassert.ok(src);\n`,
  });
  assert.equal(classifyTestFile("tests/a.test.mjs", root).evidenceClass, "source_contract");

  const executing = sandbox({
    "tests/a.test.mjs": `await fetch(process.env.PAWSPACE_HOSTED_BASE_URL + "/health");\n`,
  });
  assert.equal(classifyTestFile("tests/a.test.mjs", executing).evidenceClass, "hosted_provider");
});

test("importing the real module without a database is imported_unit, and adding one makes it real_execution", () => {
  const unit = sandbox({ "tests/a.test.mjs": `const m = await import("../lib/refunds.ts");\nm.decide();\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", unit).evidenceClass, "imported_unit");

  const withDb = sandbox({ "tests/a.test.mjs": `import { DatabaseSync } from "node:sqlite";\nconst m = await import("../lib/refunds.ts");\nm.decide(new DatabaseSync(":memory:"));\n` });
  const row = classifyTestFile("tests/a.test.mjs", withDb);
  assert.equal(row.evidenceClass, "real_execution");
  assert.equal(row.database, true);
});

test("a database with nothing imported is still only source_contract", () => {
  // node:sqlite on its own proves nothing about the product: the suite has to drive real code with it.
  const root = sandbox({ "tests/a.test.mjs": `import { DatabaseSync } from "node:sqlite";\nnew DatabaseSync(":memory:").exec("create table t(x)");\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", root).evidenceClass, "source_contract");
});

test("route handler execution is counted, including sweeps built from a template literal", () => {
  // The fixtures call the handler they import; an inert import is covered separately below.
  const root = sandbox({
    "tests/a.test.mjs": `import { DatabaseSync } from "node:sqlite";\nconst { POST } = await import("../app/api/voice-outbound/route.ts");\nawait POST(new Request("http://x/api/voice-outbound", { method: "POST" }));\n`,
    "tests/b.test.mjs": "import { DatabaseSync } from \"node:sqlite\";\nfor (const n of names) { const m = await import(`../app/api/${n}/route.ts`); await m.GET(new Request(`http://x/api/${n}`)); }\n",
  });
  assert.equal(classifyTestFile("tests/a.test.mjs", root).routeHandlersExecuted, 1);
  assert.equal(classifyTestFile("tests/b.test.mjs", root).routeHandlersExecuted, 1);
  assert.equal(classifyTestFile("tests/a.test.mjs", root).module, "voice");
});

test("signals reached only through a test helper still count", () => {
  const files = {
    "tests/helpers/journey.mjs": `import { DatabaseSync } from "node:sqlite";\nexport async function routeCall() { const db = new DatabaseSync(":memory:"); db.exec("create table proof(x)"); return (await import("../../app/api/uat-scheduling/route.ts")).POST; }\n`,
    "tests/a.test.mjs": `import { routeCall } from "./helpers/journey.mjs";\nawait routeCall();\n`,
  };
  const root = sandbox(files);
  const row = classifyTestFile("tests/a.test.mjs", root);
  assert.equal(row.evidenceClass, "real_execution", "a suite that drives routes through a helper is not a source-text read");
  assert.equal(row.routeHandlersExecuted, 1);

  // Sabotage: the same suite with the helper's execution removed must drop to source_contract.
  const inert = sandbox({ ...files, "tests/helpers/journey.mjs": `export async function routeCall() { return null; }\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", inert).evidenceClass, "source_contract");
});

test("booting a real Worker over a real D1 binding is real_execution even with no node:sqlite import", () => {
  const files = {
    "wrangler.demo.jsonc": `{ "main": "tests/demo-worker.ts", "d1_databases": [{ "binding": "DB" }] }`,
    "tests/demo-worker.ts": `import { POST } from "../app/api/canonical-bookings/route.ts";\nexport default { fetch: POST };\n`,
    "tests/a.test.mjs": `import { spawn } from "node:child_process";\nspawn("npx", ["wrangler", "dev", "--config", "wrangler.demo.jsonc"]);\nconst response = await fetch("http://127.0.0.1:8799/run");\nassert.equal(response.status, 200);\n`,
  };
  const root = sandbox(files);
  const row = classifyTestFile("tests/a.test.mjs", root);
  assert.equal(row.evidenceClass, "real_execution");
  assert.equal(row.localWorker, true);
  assert.equal(row.routeHandlersExecuted, 1, "the worker entry's routes are the routes this suite exercises");

  // Sabotage: without the wrangler spawn the same suite proves nothing.
  const inert = sandbox({ ...files, "tests/a.test.mjs": `import { spawn } from "node:child_process";\nspawn("npx", ["echo"]);\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", inert).evidenceClass, "source_contract");
});

test("an inert product import is not promoted to executable evidence", () => {
  const hollow = sandbox({
    "tests/a.test.mjs": `import { DatabaseSync } from "node:sqlite";\nimport * as refunds from "../lib/refunds.ts";\nassert.ok(true);\n`,
  });
  const row = classifyTestFile("tests/a.test.mjs", hollow);
  assert.equal(row.evidenceClass, "source_contract");
  assert.equal(row.modulesExecuted, 0);
  assert.equal(row.database, false, "an unused node:sqlite import does not prove persistence execution");
});

test("only an environment-supplied hosted or provider origin counts as hosted_provider", () => {
  const literal = sandbox({ "tests/a.test.mjs": `assert.match(src, /https:\\/\\/api.anthropic.com/);\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", literal).evidenceClass, "source_contract",
    "a provider URL quoted inside an assertion is a fixture, not traffic");

  const hosted = sandbox({ "tests/a.test.mjs": `const r = await fetch(process.env.PAWSPACE_HOSTED_BASE_URL + "/api/health");\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", hosted).evidenceClass, "hosted_provider");
});

test("a path named only in a comment is not read as an import", () => {
  const root = sandbox({ "tests/a.test.mjs": `// see ../lib/refunds.ts for the gate\n/* await import("../lib/pricing.ts") */\nassert.ok(true);\n` });
  assert.deepEqual(executedSourceModules(fs.readFileSync(path.join(root, "tests/a.test.mjs"), "utf8")), []);
  assert.equal(classifyTestFile("tests/a.test.mjs", root).evidenceClass, "source_contract");
});

test("import-like text inside a string is not executable evidence", () => {
  const root = sandbox({ "tests/a.test.mjs": `const fixture = 'import { refund } from "../lib/refunds.ts"';\nassert.ok(fixture);\n` });
  assert.deepEqual(executedSourceModules(fs.readFileSync(path.join(root, "tests/a.test.mjs"), "utf8")), []);
  assert.equal(classifyTestFile("tests/a.test.mjs", root).evidenceClass, "source_contract");
});

test("a Wrangler config name without both dev launch and HTTP traffic is not Worker execution", () => {
  const files = {
    "wrangler.demo.jsonc": `{ "main": "tests/demo-worker.ts", "d1_databases": [{ "binding": "DB" }] }`,
    "tests/demo-worker.ts": `import { POST } from "../app/api/canonical-bookings/route.ts";\nexport default { fetch: POST };\n`,
    "tests/a.test.mjs": `const config = "wrangler.demo.jsonc";\nassert.ok(config);\n`,
  };
  assert.equal(classifyTestFile("tests/a.test.mjs", sandbox(files)).evidenceClass, "source_contract");
  const launchOnly = sandbox({ ...files, "tests/a.test.mjs": `spawn("npx", ["wrangler", "dev", "--config", "wrangler.demo.jsonc"]);\n` });
  assert.equal(classifyTestFile("tests/a.test.mjs", launchOnly).evidenceClass, "source_contract");
});

test("a name promising execution while only reading source is reported, and this repository has none", () => {
  const lying = sandbox({ "tests/pricing-real-d1.test.mjs": `import fs from "node:fs";\nfs.readFileSync("lib/pricing.ts", "utf8");\n` });
  assert.equal(classifyTestFile("tests/pricing-real-d1.test.mjs", lying).misleadingName, true);

  const summary = summariseEvidence(auditEvidenceClasses("tests", "."));
  assert.deepEqual(summary.misleading, [],
    "a suite whose name claims real execution must actually execute something - rename it or make it execute");
});

/**
 * The 39 suites named `<vertical>-gate<N>` / `<vertical>-closure` that carry a whole vertical's "gate"
 * on a grep of its lib files. They belong to other closure lanes, so they are frozen here rather than
 * renamed across a lane boundary. Frozen as a SET, not as a count: a count-only guard let a NEW
 * overclaiming suite appear as long as an old one was renamed away in the same change, which is
 * exactly the drift the guard exists to stop.
 */
const KNOWN_OVERCLAIMING = new Set([
  "boarding-gate1", "boarding-gate2", "boarding-gate3", "boarding-gate4", "boarding-gate5",
  "food-closure", "food-gate1", "food-gate2", "food-gate3", "food-gate4", "food-gate5",
  "funeral-memorial-closure", "grooming-closure", "platform-closure", "relocation-closure",
  // Arrived on main in #303, after this branch was cut. Recorded here rather than renamed: it belongs
  // to the grooming lane. This is the guard working as intended - a new source-text suite claiming a
  // "truth" in its name cannot land unremarked, it has to be acknowledged in this list first.
  "grooming-commercial-catalogue-truth",
  "sitting-gate1", "sitting-gate2", "sitting-gate3", "sitting-gate4", "sitting-gate5",
  "taxi-closure", "taxi-gate1", "taxi-gate2", "taxi-gate3", "taxi-gate4", "taxi-gate5",
  "training-closure", "training-gate3",
  "uat-closure-customer-journeys", "uat-closure-home-booking", "uat-closure-provider-fulfilment",
  "uat-closure-service-flows", "uat-training-partner-closure",
  "walking-closure", "walking-gate1", "walking-gate2", "walking-gate3", "walking-gate4", "walking-gate5",
]);

test("verdict-claiming source-text suite names may shrink but never grow", () => {
  const summary = summariseEvidence(auditEvidenceClasses("tests", "."));
  const current = summary.overclaiming.map(file => path.basename(file).replace(".test.mjs", ""));
  const added = current.filter(name => !KNOWN_OVERCLAIMING.has(name));
  assert.deepEqual(added, [],
    `a new source-text suite is claiming a gate/closure/truth in its name: ${added.join(", ")}. Execute something, or name it a source contract.`);
  for (const file of summary.overclaiming) {
    assert.doesNotMatch(file, /\/(ai|voice|readiness|integration|release|staging)-/,
      `${file} is in Lane 4 scope: either execute something or name it a source contract`);
  }
});

test("real executable evidence, not suite volume, backs the AI and voice modules", () => {
  const summary = summariseEvidence(auditEvidenceClasses("tests", "."));
  const byModule = new Map(summary.byModule);
  for (const name of ["ai", "voice"]) {
    const bucket = byModule.get(name);
    assert.ok(bucket, `no suites bucket to ${name}`);
    assert.ok(bucket.real_execution + bucket.imported_unit >= 6,
      `${name} has ${bucket.real_execution} real_execution + ${bucket.imported_unit} imported_unit suites; source-text volume is not proof`);
  }
});
