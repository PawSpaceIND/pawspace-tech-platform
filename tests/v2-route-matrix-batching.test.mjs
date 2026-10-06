import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Tests the real spec's registration, route partition and failure propagation. Page operations here
// are explicit doubles, not browser evidence. The unchanged Playwright workflow renders every case.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("../e2e/v2-ui-theme-closure.spec.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const variants = ["desktop-brand-professional-light", "desktop-brand-professional-dark",
  "desktop-emerald-illustrated-light", "mobile-brand-professional-light"];
function discovered(dir, prefix = "/v2") {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? discovered(path.join(dir, entry.name), `${prefix}/${entry.name}`)
    : entry.name === "page.tsx" ? [prefix] : []).sort();
}
function suite(routeDirectory = path.join(root, "app/v2")) {
  const cases = [], deadlines = [];
  const register = (title, run) => cases.push({ title, run });
  register.beforeEach = () => {};
  register.use = () => {};
  register.setTimeout = ms => deadlines.push(ms);
  register.step = async (_name, run) => run();
  const expect = value => ({ toBe: expected => assert.equal(value, expected),
    toContain: expected => assert.ok(value.includes(expected)),
    toBeLessThanOrEqual: expected => assert.ok(value <= expected),
    toBeVisible: async () => {}, toHaveAttribute: async () => {} });
  expect.soft = expect;
  const require = name => {
    if (name === "@playwright/test") return { test: register, expect };
    if (name === "node:fs") return { readdirSync };
    if (name === "node:path") return { ...path, resolve: (...parts) =>
      parts.length === 1 && parts[0] === "app/v2" ? routeDirectory : path.resolve(...parts) };
    throw new Error(`Unexpected dependency in route matrix registration: ${name}`);
  };
  runInNewContext(compiled, { require, exports: {}, URL, process: { env: { PW_BASE_URL: "http://localhost:4185" } } },
    { filename: "v2-ui-theme-closure.spec.ts" });
  return { cases: cases.filter(item => item.title.startsWith("V2 route matrix:")), deadlines };
}
function probe(failureRoute) {
  const visited = [], screenshots = [], attachments = []; let current = "";
  const page = {
    setViewportSize: async () => {}, addInitScript: async () => {},
    context: () => ({
      addCookies: async () => {},
      cookies: async () => [{ name: "pawspace-appearance", value: "v1.-.editorial.light.theme~emerald~style~cartoon" }],
    }),
    goto: async route => { visited.push(route); if (route === failureRoute) throw new Error(`broken route ${route}`); current = route; },
    locator: () => ({}), waitForFunction: async () => {}, waitForTimeout: async () => {},
    getByRole: () => ({ isVisible: async () => false }),
    evaluate: async () => ({ url: current, canvas: "fixture", body: "fixture", width: 390, scrollWidth: 390 }),
    screenshot: async options => { screenshots.push(options.path); },
  };
  const info = { outputPath: name => name, attach: async (_name, data) => attachments.push(JSON.parse(data.body)) };
  return { page, info, visited, screenshots, attachments };
}

test("every discovered V2 route retains all four appearances exactly once in bounded cases", async () => {
  const expected = discovered(path.join(root, "app/v2")), matrix = suite();
  assert.ok(expected.length > 0);
  assert.equal(matrix.cases.length, Math.ceil(expected.length / 8) * variants.length);
  for (const variant of variants) {
    const selected = matrix.cases.filter(item => item.title.startsWith(`V2 route matrix: ${variant} `));
    assert.equal(selected.length, Math.ceil(expected.length / 8));
    const covered = [];
    for (const item of selected) {
      const p = probe(); await item.run({ page: p.page }, p.info);
      assert.ok(p.visited.length > 0 && p.visited.length <= 8, item.title);
      assert.equal(p.screenshots.length, p.visited.length, "each route must retain its screenshot");
      assert.deepEqual(p.attachments.flat().map(row => row.route), p.visited);
      covered.push(...p.visited);
    }
    assert.deepEqual(covered, expected, `missing, duplicated or reordered routes in ${variant}`);
  }
  assert.equal(matrix.deadlines.length, matrix.cases.length);
  assert.ok(matrix.deadlines.every(ms => ms === 120_000), "bounded cases, not a raised global timeout");
});

test("a failed route still fails its case and retains preceding evidence", async () => {
  const expected = discovered(path.join(root, "app/v2")); assert.ok(expected.length >= 2);
  const matrix = suite(), p = probe(expected[1]);
  await assert.rejects(matrix.cases[0].run({ page: p.page }, p.info), /broken route/);
  assert.deepEqual(p.visited, expected.slice(0, 2));
  assert.equal(p.screenshots.length, 1);
  assert.deepEqual(p.attachments.flat().map(row => row.route), expected.slice(0, 1));
});

test("an empty route inventory cannot silently certify zero routes", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "v2-matrix-empty-")); t.after(() => rmSync(dir, { recursive: true }));
  assert.throws(() => suite(dir), /No PawSpace V2 routes/);
});

test("future routes create additional cases instead of growing one unbounded test", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "v2-matrix-growth-")); t.after(() => rmSync(dir, { recursive: true }));
  for (let i = 0; i < 137; i++) {
    const route = path.join(dir, `module-${String(i).padStart(3, "0")}`); mkdirSync(route);
    writeFileSync(path.join(route, "page.tsx"), "// Scheduling fixture only.\n");
  }
  const matrix = suite(dir), selected = matrix.cases.filter(item => item.title.startsWith(`V2 route matrix: ${variants[0]} `));
  assert.equal(selected.length, 18);
  const covered = [];
  for (const item of selected) { const p = probe(); await item.run({ page: p.page }, p.info); assert.ok(p.visited.length <= 8); covered.push(...p.visited); }
  assert.deepEqual(covered, discovered(dir));
});
