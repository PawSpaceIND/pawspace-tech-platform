/**
 * Persona smoke: does a real browser, signed in as a real person, get a working screen?
 *
 * The 1600-odd unit tests are a good logic net with no UI net and no auth-path net. They run as a
 * development-preview superuser, inject the rows they assert on, and several hundred of them check
 * that a source file CONTAINS a string rather than that the code behaves. Every failure found by
 * hand during UAT - permission denied everywhere, forms posting 400, a console rendering as an
 * unstyled column, screens that paint a heading over nothing - lives in the seam none of that
 * crosses. This walks the deployed routes in Chromium and asserts what a person would notice.
 *
 * Two modes:
 *   PAWSPACE_E2E_ACCESS_CODE set -> signs in at /staging-login first, so gated screens are real.
 *   unset                        -> public mode: gated screens are expected to ask for sign-in, and
 *                                   the run still catches render, layout, script and type failures.
 *
 * The access code is only ever read from the environment. It is never written to a file, a log line
 * or an assertion message.
 *
 * Usage: node tests/e2e/persona-smoke.mjs [--base https://…] [--routes a,b,c] [--json out.json]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const BASE = (arg("base", process.env.PAWSPACE_E2E_BASE || "http://127.0.0.1:3000")).replace(/\/$/, "");
const ACCESS_CODE = process.env.PAWSPACE_E2E_ACCESS_CODE || "";
const IDENTITY = process.env.PAWSPACE_E2E_IDENTITY || "founder@pawspace.in";
const CHROMIUM = process.env.PAWSPACE_E2E_CHROMIUM || undefined;
const SETTLE_MS = Number(process.env.PAWSPACE_E2E_SETTLE_MS || 2500);

/** Nothing on a staff console should render below this; see the type scale in globals.css. */
const MIN_FONT_PX = 12;
/** The palette every surface was moved onto. A violet here means a screen was missed. */
const LEGACY_VIOLET = /^rgb\((\d+), (\d+), (\d+)\)$/;

/** Routes come from the app directory, so a new page is covered the day it is added. */
function discoverRoutes(root = "app", url = "") {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === "page.tsx") found.push(url || "/");
      continue;
    }
    if (["api", "components"].includes(entry.name) || entry.name.startsWith("_")) continue;
    found.push(...discoverRoutes(path.join(root, entry.name), `${url}/${entry.name}`));
  }
  return found.filter((route) => !route.includes("["));
}

const ROUTES = (arg("routes") ? arg("routes").split(",") : discoverRoutes()).sort();

function isVioletish(colour) {
  const match = LEGACY_VIOLET.exec(colour);
  if (!match) return false;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return b > g + 25 && r > g + 8 && b >= r;
}

async function signIn(page) {
  if (!ACCESS_CODE) return "public";
  await page.goto(`${BASE}/staging-login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const code = page.locator('input[type="password"], input[name*="code" i]').first();
  const email = page.locator('input[type="email"], input[name*="email" i]').first();
  if (await email.count()) await email.fill(IDENTITY);
  if (await code.count()) await code.fill(ACCESS_CODE);
  await page.locator('button[type="submit"], button').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  const signedIn = !page.url().includes("/staging-login");
  if (!signedIn) throw new Error("staging sign-in did not complete (check the access code secret)");
  return "signed-in";
}

/** Everything a person would notice, gathered in one pass so a route is visited once. */
async function inspect(page) {
  return page.evaluate((minFont) => {
    const body = document.body;
    const main = document.querySelector("main") || body;
    const text = (main.innerText || "").trim();

    const tooSmall = [];
    const violet = [];
    for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 4000)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own && size && size < minFont) tooSmall.push(`${el.tagName.toLowerCase()} @${size}px`);
      if (own) violet.push(style.color);
      violet.push(style.backgroundColor);
    }
    return {
      title: document.title,
      textLength: text.length,
      headings: document.querySelectorAll("h1").length,
      overflowPx: Math.max(0, body.scrollWidth - window.innerWidth),
      tooSmall: [...new Set(tooSmall)].slice(0, 5),
      colours: [...new Set(violet)],
      /* The banners a person reads as "this page is broken". */
      sawAuthWall: /Permission denied|Authentication required|sign-in has expired|Access has not been provisioned/i.test(text),
      sawJsonError: /Unexpected token|is not valid JSON/i.test(text),
      sawServerError: /Internal Server Error|failed to load|Unable to load/i.test(text),
      snippet: text.slice(0, 120).replace(/\s+/g, " "),
    };
  }, MIN_FONT_PX);
}

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ["--no-sandbox", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160)); });
page.on("pageerror", (error) => pageErrors.push(String(error.message).slice(0, 160)));

const mode = await signIn(page);
console.log(`persona-smoke · ${mode} · ${BASE} · ${ROUTES.length} routes\n`);

const findings = [];
for (const route of ROUTES) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  let status = 0;
  try {
    const response = await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 });
    status = response ? response.status() : 0;
  } catch (error) {
    findings.push({ route, kind: "navigation", detail: String(error.message).split("\n")[0] });
    continue;
  }
  await page.waitForTimeout(SETTLE_MS);

  let seen;
  try { seen = await inspect(page); }
  catch (error) { findings.push({ route, kind: "inspect", detail: String(error.message).split("\n")[0] }); continue; }

  const add = (kind, detail) => findings.push({ route, kind, detail });
  if (status >= 400) add("http", `HTTP ${status}`);
  if (pageErrors.length) add("script", pageErrors[0]);
  // A heading plus a way onward is a legitimate minimal state (an empty-state screen waiting for an
  // id, for instance). Only a page with neither is blank.
  if (seen.textLength < 40 && !seen.headings) add("blank", `${seen.textLength} characters and no heading`);
  if (!seen.headings) add("no-heading", "no <h1> on the page");
  if (seen.overflowPx > 2) add("overflow", `${seen.overflowPx}px wider than the viewport`);
  if (seen.tooSmall.length) add("tiny-type", seen.tooSmall.join(", "));
  if (seen.colours.some(isVioletish)) add("legacy-violet", seen.colours.filter(isVioletish).slice(0, 3).join(" "));
  if (seen.sawJsonError) add("json-error", seen.snippet);
  if (seen.sawServerError) add("server-error", seen.snippet);
  if (mode === "signed-in" && seen.sawAuthWall) add("auth-wall", seen.snippet);
  const noisy = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
  if (noisy.length) add("console", noisy[0]);
}

await browser.close();

const byKind = findings.reduce((acc, f) => { (acc[f.kind] ||= []).push(f); return acc; }, {});
console.log(`${ROUTES.length - new Set(findings.map((f) => f.route)).size}/${ROUTES.length} routes clean\n`);
for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${kind} (${list.length})`);
  for (const f of list.slice(0, 12)) console.log(`   ${f.route.padEnd(38)} ${f.detail}`);
  if (list.length > 12) console.log(`   … ${list.length - 12} more`);
  console.log();
}

const out = arg("json");
if (out) fs.writeFileSync(out, JSON.stringify({ base: BASE, mode, routes: ROUTES.length, findings }, null, 2));
process.exit(findings.length ? 1 : 0);
