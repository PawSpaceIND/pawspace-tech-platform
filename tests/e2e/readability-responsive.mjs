/**
 * Readability and responsive gate.
 *
 * scripts/screen-sweep.mjs already opens every route in a browser and judges whether a screen is
 * usable - status, failed /api calls, console errors, whether there is anything to do on the page.
 * This does not repeat any of that. It reuses that route discovery and measures the two dimensions
 * that sweep does not, both of which shipped to staging unnoticed:
 *
 *   - type below a readable floor. /control set its own scale at 6-8px across fifteen stylesheets and
 *     rendered at 10px; nobody could read it, and no test could see it.
 *   - horizontal scroll on a phone. A staff screen that scrolls sideways at 390px is unusable in the
 *     field, which is where boarding and grooming staff actually open it.
 *
 * Gated on ui-baseline.json: the platform starts with real debt here, so this fails on what is NEW
 * rather than on what was already broken. Improvements are reported so the baseline can be tightened.
 *
 * Run:  node tests/e2e/readability-responsive.mjs --serve
 *       node tests/e2e/readability-responsive.mjs --serve --update-baseline
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { discoverRoutes } from "../../scripts/screen-sweep.mjs";

const { chromium } = await import("playwright").catch(() => import("playwright-core"));

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8787";
const PORT = Number(new URL(BASE).port || 8787);
const MIN_FONT_PX = 12;
const PHONE = { width: 390, height: 844 };
const CONFIG = "dist/server/wrangler.json";

async function startServer() {
  if (!existsSync(CONFIG)) throw new Error("dist/server/wrangler.json missing - run `npm run build` first");
  const parsed = JSON.parse(await readFile(CONFIG, "utf8"));
  parsed.vars = { ...(parsed.vars || {}), PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_ACCESS_CODE: "smoke-access-code", PAWSPACE_UAT_SIGNING_KEY: "smoke-signing-key-not-a-real-secret-0123456789" };
  await writeFile(CONFIG, JSON.stringify(parsed));
  const child = spawn("npx", ["wrangler", "dev", "--config", CONFIG, "--port", String(PORT), "--local", "--ip", "127.0.0.1"], { stdio: "ignore" });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { await fetch(`${BASE}/team`, { redirect: "manual" }); return child; }
    catch { await new Promise((resolve) => setTimeout(resolve, 2000)); }
  }
  child.kill("SIGKILL");
  throw new Error("wrangler dev did not become ready within 180s");
}

const signature = (problem) => problem.replace(/\(\+\d+px\)/, "(+Npx)").replace(/at [\d.]+px/, "at Npx").replace(/"[^"]*"/, '"..."');

async function main() {
  const routes = (await discoverRoutes()).map((route) => (typeof route === "string" ? route : route.route ?? route.path));
  if (routes.length < 20) throw new Error(`route discovery returned ${routes.length} routes - refusing to run a gate that checks almost nothing`);

  const server = process.argv.includes("--serve") ? await startServer() : null;
  const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.SMOKE_CHROMIUM_PATH ? { executablePath: process.env.SMOKE_CHROMIUM_PATH } : {}) });
  const current = {};

  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(`${BASE}/staging-login`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate(async () => {
      await fetch("/api/staging-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "smoke-access-code", email: "smoke@pawspace.test" }) }).catch(() => {});
    });

    for (const route of routes) {
      const problems = [];
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
        await page.waitForTimeout(400);
      } catch { continue; }

      const smallest = await page.evaluate(() => {
        let size = Infinity, text = "";
        for (const element of document.querySelectorAll("body *")) {
          const own = (element.textContent || "").trim();
          if (!own || element.children.length) continue;
          const px = parseFloat(getComputedStyle(element).fontSize);
          if (px < size) { size = px; text = own.slice(0, 40); }
        }
        return Number.isFinite(size) ? { size: Math.round(size * 10) / 10, text } : null;
      });
      if (smallest && smallest.size < MIN_FONT_PX) problems.push(`text at ${smallest.size}px ("${smallest.text}") is below the ${MIN_FONT_PX}px floor`);

      await page.setViewportSize(PHONE);
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 8) problems.push(`scrolls sideways on a ${PHONE.width}px screen (+${overflow}px)`);
      await page.setViewportSize({ width: 1280, height: 900 });

      if (problems.length) current[route] = [...new Set(problems.map(signature))].sort();
      console.log(`${problems.length ? "FAIL" : "ok  "}  ${route}${problems.length ? ` - ${problems.join("; ")}` : ""}`);
    }
  } finally {
    await browser.close();
    server?.kill("SIGKILL");
  }

  const baselineUrl = new URL("./ui-baseline.json", import.meta.url);
  if (process.argv.includes("--update-baseline")) {
    await writeFile(baselineUrl, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`\nbaseline written: ${Object.keys(current).length} routes with known problems`);
    return;
  }

  const baseline = existsSync(baselineUrl) ? JSON.parse(await readFile(baselineUrl, "utf8")) : {};
  const regressions = Object.entries(current)
    .map(([route, problems]) => ({ route, problems: problems.filter((p) => !(baseline[route] || []).includes(p)) }))
    .filter((entry) => entry.problems.length);
  const fixed = Object.entries(baseline)
    .map(([route, problems]) => ({ route, problems: problems.filter((p) => !(current[route] || []).includes(p)) }))
    .filter((entry) => entry.problems.length);

  console.log(`\n${routes.length} routes checked · ${Object.keys(current).length} with problems · ${Object.keys(baseline).length} known in the baseline`);
  if (fixed.length) {
    console.log(`\nFixed since the baseline (${fixed.length} route(s)) - rerun with --update-baseline to lock it in:`);
    for (const item of fixed) console.log(`  ${item.route}: ${item.problems.join("; ")}`);
  }
  if (regressions.length) {
    console.log(`\nNEW problems (${regressions.length} route(s)):`);
    for (const item of regressions) console.log(`  ${item.route}\n    - ${item.problems.join("\n    - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo new readability or responsive problems.");
  }
}

await main();
