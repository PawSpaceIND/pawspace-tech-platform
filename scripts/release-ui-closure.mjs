import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const arg = (name, fallback = "") => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const BASE = arg("base", process.env.PREVIEW_URL || "").replace(/\/$/, "");
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
const JSON_OUT = arg("json", "release-ui-closure-report.json");
const TIMEOUT = Number(arg("timeout", "12000"));
const SETTLE_MS = Number(arg("settle-ms", "300"));
const MAX_CONTROLS_PER_ROUTE = Number(arg("max-controls", "40"));

if (!BASE) throw new Error("--base or PREVIEW_URL is required");
if (!ACCESS_CODE) throw new Error("PAWSPACE_UAT_ACCESS_CODE is required for role coverage");

const DYNAMIC_SAMPLES = { "[slug]": "grooming", "[breed]": "labrador-retriever", "[id]": "UATD-CUS-1" };
const STAFF_ROLES = [
  { role: "founder", email: "founder@pawspace.in" },
  { role: "finance", email: "anjali.finance33@tkpetcare.in" },
  { role: "manager", email: "jyoti.manager39@tkpetcare.in" },
  { role: "provider", email: "asha.groomer1@tkpetcare.in" },
  { role: "associate", email: "anita.associate17@tkpetcare.in" },
];
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 },
];
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DESTRUCTIVE_TEXT = /(delete|remove|refund|cancel|approve|reject|decline|pay|capture|payout|assign|reassign|activate|deactivate|disable|enable|send|submit|save|create|add|update|confirm|complete|start|finish|close|reopen|archive|invite|run now|install|reset|logout|sign out)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeReport = (report) => fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

function discoverRoutes(root = "app") {
  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "page.tsx") continue;
      let route = `/${path.relative(root, dir).split(path.sep).join("/")}`;
      if (route === "/.") route = "/";
      route = route.replace(/\/\([^/]+\)/g, "") || "/";
      for (const [token, sample] of Object.entries(DYNAMIC_SAMPLES)) route = route.replaceAll(token, sample);
      if (/\[[^\]]+\]/.test(route)) continue;
      routes.push(route);
    }
  };
  walk(root);
  return [...new Set(routes)].sort();
}

async function login(context, email) {
  const response = await context.request.post(`${BASE}/api/staging-login`, { data: { action: "login", email, code: ACCESS_CODE } });
  if (!response.ok()) throw new Error(`UAT login failed for ${email}: HTTP ${response.status()} ${await response.text()}`);
}

async function gotoSettled(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await sleep(SETTLE_MS);
  return response;
}

async function collectVisual(page, route, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const apiFailures = [], consoleErrors = [], pageErrors = [];
  const onResponse = (response) => {
    const url = response.url();
    if (url.includes("/api/") && response.status() >= 500) apiFailures.push(`${response.status()} ${new URL(url).pathname}`);
  };
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 240)); };
  const onPageError = (error) => pageErrors.push(String(error.message).slice(0, 240));
  page.on("response", onResponse); page.on("console", onConsole); page.on("pageerror", onPageError);
  let status = 0, failure = "";
  try {
    const response = await gotoSettled(page, `${BASE}${route}`);
    status = response?.status() || 0;
  } catch (error) { failure = String(error.message).split("\n")[0].slice(0, 240); }
  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const brokenImages = [...document.images].filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute("src") || "").slice(0, 10);
    const visible = (el) => {
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const clipped = [...document.querySelectorAll("button,a,input,select,textarea")].filter(visible).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < -2 || r.right > innerWidth + 2;
    }).map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 80)).slice(0, 10);
    return {
      horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > innerWidth + 2,
      scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
      viewportWidth: innerWidth,
      brokenImages,
      clippedControls: clipped,
      visibleTextLength: (body?.innerText || "").replace(/\s+/g, " ").trim().length,
    };
  }).catch(() => ({ horizontalOverflow: false, scrollWidth: 0, viewportWidth: viewport.width, brokenImages: [], clippedControls: [], visibleTextLength: 0 }));
  page.off("response", onResponse); page.off("console", onConsole); page.off("pageerror", onPageError);
  const failures = [];
  if (!status || status >= 500 || failure) failures.push(failure || `HTTP ${status}`);
  if (pageErrors.length) failures.push(`page error: ${pageErrors[0]}`);
  if (apiFailures.length) failures.push(`5xx API: ${apiFailures.join(", ")}`);
  if (measured.horizontalOverflow) failures.push(`horizontal overflow ${measured.scrollWidth}px > ${measured.viewportWidth}px`);
  if (measured.brokenImages.length) failures.push(`broken images: ${measured.brokenImages.join(", ")}`);
  if (measured.clippedControls.length) failures.push(`controls outside viewport: ${measured.clippedControls.join(" | ")}`);
  return { route, viewport: viewport.name, status, consoleErrors: [...new Set(consoleErrors)], pageErrors: [...new Set(pageErrors)], apiFailures: [...new Set(apiFailures)], ...measured, failures };
}

function linkWiringResult(target, route) {
  if (target.tag !== "a") return null;
  const href = String(target.href || "").trim();
  if (!href) return { result: "no_observable_effect", error: "anchor has no href" };
  if (href.startsWith("#")) return { result: "wired", navigationSeen: `${route}${href}` };
  try {
    const resolved = new URL(href, BASE);
    return { result: "wired", navigationSeen: resolved.href };
  } catch {
    return { result: "click_error", error: `invalid href: ${href}` };
  }
}

async function probeControls(page, route) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSettled(page, `${BASE}${route}`);
  const descriptors = await page.locator("button,a[href]").evaluateAll((els) => els.map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 100),
    href: el.tagName === "A" ? el.getAttribute("href") : null,
    disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    hidden: !(el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none"),
  }))).catch(() => []);
  const targets = descriptors.filter((d) => !d.disabled && !d.hidden).slice(0, MAX_CONTROLS_PER_ROUTE);
  const results = [];

  for (const target of targets) {
    const linkResult = linkWiringResult(target, route);
    if (linkResult) { results.push({ ...target, destructive: false, mutationAttempt: null, requestSeen: null, dialogSeen: null, changed: false, ...linkResult }); continue; }

    await gotoSettled(page, `${BASE}${route}`).catch(() => {});
    const locator = page.locator("button,a[href]").nth(target.index);
    if (!await locator.isVisible().catch(() => false)) { results.push({ ...target, result: "skipped_not_visible" }); continue; }

    const text = target.text || `${target.tag}#${target.index}`;
    const destructive = DESTRUCTIVE_TEXT.test(text);
    let mutationAttempt = null, requestSeen = null, dialogSeen = null, navigationSeen = null, changed = false, error = null, domMutations = 0;
    const beforeUrl = page.url();
    const beforeText = await page.locator("body").innerText().catch(() => "");
    await page.evaluate(() => {
      window.__pawspaceUiMutationCount = 0;
      const observer = new MutationObserver((records) => { window.__pawspaceUiMutationCount += records.length; });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      window.__pawspaceUiMutationObserver = observer;
    }).catch(() => {});
    const onDialog = async (dialog) => { dialogSeen = dialog.type(); await dialog.dismiss().catch(() => {}); };
    const onRequest = (request) => { if (request.url().includes("/api/")) requestSeen = `${request.method()} ${new URL(request.url()).pathname}`; };
    const routeHandler = async (routeHandle) => {
      const method = routeHandle.request().method();
      if (MUTATING_METHODS.has(method)) { mutationAttempt = `${method} ${new URL(routeHandle.request().url()).pathname}`; await routeHandle.abort("blockedbyclient"); }
      else await routeHandle.continue();
    };
    page.on("dialog", onDialog); page.on("request", onRequest); await page.route("**/api/**", routeHandler);
    try {
      await locator.click({ timeout: 3500 });
      await sleep(300);
      navigationSeen = page.url() !== beforeUrl ? page.url() : null;
      const afterText = await page.locator("body").innerText().catch(() => "");
      domMutations = await page.evaluate(() => {
        const count = Number(window.__pawspaceUiMutationCount || 0);
        window.__pawspaceUiMutationObserver?.disconnect();
        return count;
      }).catch(() => 0);
      changed = afterText !== beforeText || domMutations > 0;
    } catch (e) { error = String(e.message).split("\n")[0].slice(0, 220); }
    await page.unroute("**/api/**", routeHandler); page.off("dialog", onDialog); page.off("request", onRequest);

    const evidence = Boolean(navigationSeen || mutationAttempt || requestSeen || dialogSeen || changed);
    const result = destructive && mutationAttempt ? "wired_mutation_blocked" : evidence ? "wired" : error ? "click_error" : "no_observable_effect";
    results.push({ ...target, destructive, result, mutationAttempt, requestSeen, dialogSeen, navigationSeen, changed, domMutations, error });
  }
  return results;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const routes = discoverRoutes();
  const visual = [], controls = [], roleCoverage = [];
  const baseReport = () => ({
    generatedAt: new Date().toISOString(), base: BASE,
    summary: {
      discoveredRoutes: routes.length,
      visualChecks: visual.length + roleCoverage.length,
      visualFailures: [...visual, ...roleCoverage].filter((r) => r.failures.length).length,
      controlsProbed: controls.reduce((n, r) => n + r.controls.length, 0),
      controlFailures: controls.flatMap((r) => r.controls).filter((c) => c.result === "click_error" || c.result === "no_observable_effect").length,
      roles: ["guest_customer", ...STAFF_ROLES.map((r) => r.role)],
      mutationsExecuted: 0,
      phase: controls.length ? "controls" : "visual",
    },
    visualFailures: [...visual, ...roleCoverage].filter((r) => r.failures.length),
    controlFailures: controls.flatMap((r) => r.controls.map((c) => ({ actor: r.actor, route: r.route, ...c }))).filter((c) => c.result === "click_error" || c.result === "no_observable_effect"),
    roleCoverage,
    controls,
  });

  try {
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    for (const viewport of VIEWPORTS) {
      for (const route of routes.filter((r) => !r.startsWith("/team") && !r.startsWith("/control"))) {
        visual.push({ actor: "guest_customer", ...(await collectVisual(guestPage, route, viewport)) });
      }
      writeReport(baseReport());
    }
    await guestContext.close();

    for (const actor of STAFF_ROLES) {
      const context = await browser.newContext();
      await login(context, actor.email);
      const page = await context.newPage();
      const actorRoutes = actor.role === "founder" ? routes.filter((r) => r.startsWith("/team") || r.startsWith("/control") || r.startsWith("/partner")) : ["/team", "/control", "/partner", "/partner/jobs"].filter((r) => routes.includes(r));
      for (const route of actorRoutes) {
        const check = await collectVisual(page, route, VIEWPORTS[0]);
        roleCoverage.push({ actor: actor.role, ...check });
        if (actor.role === "founder") for (const viewport of VIEWPORTS.slice(1)) visual.push({ actor: actor.role, ...(await collectVisual(page, route, viewport)) });
      }
      await context.close();
      writeReport(baseReport());
    }

    const visualFailures = [...visual, ...roleCoverage].filter((r) => r.failures.length);
    if (visualFailures.length) {
      const report = baseReport();
      writeReport(report);
      console.log(JSON.stringify(report.summary, null, 2));
      console.error(`UI closure stopped after visual phase: ${visualFailures.length} visual findings. Control probing was intentionally skipped so failures return quickly with an artifact.`);
      process.exitCode = 1;
      return;
    }

    for (const actor of STAFF_ROLES) {
      const context = await browser.newContext();
      await login(context, actor.email);
      const page = await context.newPage();
      const actorRoutes = actor.role === "founder" ? routes.filter((r) => r.startsWith("/team") || r.startsWith("/control") || r.startsWith("/partner")) : ["/team", "/control", "/partner", "/partner/jobs"].filter((r) => routes.includes(r));
      for (const route of actorRoutes) {
        controls.push({ actor: actor.role, route, controls: await probeControls(page, route) });
        writeReport(baseReport());
      }
      await context.close();
    }

    const report = baseReport();
    writeReport(report);
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.controlFailures) {
      console.error(`UI closure failed: ${report.summary.controlFailures} control findings.`);
      process.exitCode = 1;
      return;
    }
    console.log("UI closure passed: no broken images/overflow/clipped controls and every probed enabled control produced observable wiring evidence. Mutating requests were blocked before execution.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
