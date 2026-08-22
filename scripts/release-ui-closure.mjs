import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { CONTROL_RESULT, classifyControl, isControlFailure } from "./release-ui-control-classifier.mjs";

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

// Resolve the control the probe intends to click. The descriptor snapshot is taken once per route,
// but every control probe reloads the route first, and a route whose client data settles after the
// snapshot can render a different button set. Re-resolving by tag+text keeps the verdict attached
// to the control it names, instead of reporting a control that was never clicked.
async function resolveControlIndex(page, want, preferredIndex = -1) {
  return page.evaluate(({ want: wanted, preferredIndex: preferred }) => {
    const norm = (el) => (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const all = [...document.querySelectorAll("button,a[href]")];
    const at = preferred >= 0 ? all[preferred] : null;
    if (at && at.tagName.toLowerCase() === wanted.tag && norm(at) === wanted.text) return preferred;
    return all.findIndex((el) => el.tagName.toLowerCase() === wanted.tag && norm(el) === wanted.text);
  }, { want, preferredIndex }).catch(() => -1);
}

// Arm the per-click observers. This runs immediately before each click so a displaced-state
// re-probe measures only the target control's own effect, never the displacing sibling's.
async function armProbe(page, index) {
  await page.evaluate((targetIndex) => {
    const target = document.querySelectorAll("button,a[href]")[targetIndex];
    window.__pawspaceProbeForm = target && "form" in target ? target.form : null;
    window.__pawspaceInvalid = [];
    window.__pawspaceInvalidListener = (event) => {
      const field = event.target;
      window.__pawspaceInvalid.push({
        field: String(field.name || field.id || field.tagName || "").toLowerCase().slice(0, 60),
        sameForm: Boolean(window.__pawspaceProbeForm && field.form === window.__pawspaceProbeForm),
      });
    };
    document.addEventListener("invalid", window.__pawspaceInvalidListener, true);
    window.__pawspaceUiMutationCount = 0;
    const observer = new MutationObserver((records) => { window.__pawspaceUiMutationCount += records.length; });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__pawspaceUiMutationObserver = observer;
  }, index).catch(() => {});
}

async function readProbe(page) {
  return page.evaluate(() => {
    const domMutations = Number(window.__pawspaceUiMutationCount || 0);
    window.__pawspaceUiMutationObserver?.disconnect();
    if (window.__pawspaceInvalidListener) document.removeEventListener("invalid", window.__pawspaceInvalidListener, true);
    const invalid = (window.__pawspaceInvalid || []).filter((item) => item.sameForm);
    return { domMutations, hadForm: Boolean(window.__pawspaceProbeForm), invalidFields: [...new Set(invalid.map((item) => item.field))].slice(0, 5) };
  }).catch(() => ({ domMutations: 0, hadForm: false, invalidFields: [] }));
}

// Click one control and collect every observable effect. Mutating requests stay aborted before
// execution here exactly as before, including during a displaced-state re-probe.
async function clickAndObserve(page, index) {
  const evidence = { mutationAttempt: null, requestSeen: null, dialogSeen: null, navigationSeen: null, changed: false, domMutations: 0, validationBlocked: null, error: null };
  const locator = page.locator("button,a[href]").nth(index);
  const beforeUrl = page.url();
  const beforeText = await page.locator("body").innerText().catch(() => "");
  const onDialog = async (dialog) => { evidence.dialogSeen = dialog.type(); await dialog.dismiss().catch(() => {}); };
  const onRequest = (request) => { if (request.url().includes("/api/")) evidence.requestSeen = `${request.method()} ${new URL(request.url()).pathname}`; };
  const routeHandler = async (routeHandle) => {
    const method = routeHandle.request().method();
    if (MUTATING_METHODS.has(method)) { evidence.mutationAttempt = `${method} ${new URL(routeHandle.request().url()).pathname}`; await routeHandle.abort("blockedbyclient"); }
    else await routeHandle.continue();
  };
  page.on("dialog", onDialog); page.on("request", onRequest); await page.route("**/api/**", routeHandler);
  await armProbe(page, index);
  try {
    await locator.click({ timeout: 3500 });
    await sleep(300);
    evidence.navigationSeen = page.url() !== beforeUrl ? page.url() : null;
    const afterText = await page.locator("body").innerText().catch(() => "");
    const state = await readProbe(page);
    evidence.domMutations = state.domMutations;
    evidence.changed = afterText !== beforeText || state.domMutations > 0;
    // Constraint validation firing for this control's own form is positive proof the click reached
    // that form's submission machinery. A button wired to nothing never produces an invalid event.
    evidence.validationBlocked = state.invalidFields.length ? { form: true, fields: state.invalidFields } : null;
  } catch (error) {
    evidence.error = String(error.message).split("\n")[0].slice(0, 220);
    await readProbe(page);
  }
  await page.unroute("**/api/**", routeHandler); page.off("dialog", onDialog); page.off("request", onRequest);
  return evidence;
}

const observable = (evidence) => Boolean(evidence.navigationSeen || evidence.mutationAttempt || evidence.requestSeen || evidence.dialogSeen || evidence.changed);

async function siblingCandidates(page, index) {
  return page.evaluate((targetIndex) => {
    const all = [...document.querySelectorAll("button,a[href]")];
    const target = all[targetIndex];
    if (!target) return [];
    const visible = (el) => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
    const norm = (el) => (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const found = [];
    let scope = target.parentElement;
    for (let depth = 0; depth < 2 && scope; depth += 1) {
      for (const el of scope.querySelectorAll("button")) {
        if (el === target || el.disabled || el.getAttribute("aria-disabled") === "true" || !visible(el)) continue;
        const text = norm(el);
        if (text && !found.some((item) => item.text === text)) found.push({ tag: "button", text });
      }
      if (found.length) break;
      scope = scope.parentElement;
    }
    return found.slice(0, 6);
  }, index).catch(() => []);
}

// A filter or tab already in its selected state writes the state it already holds, React bails out,
// and nothing is committed - a correct no-op that the gate previously read as broken wiring. Click a
// sibling in the same control group first, then the target: the target must now commit an observable
// effect. This is a stronger requirement than the original single click, not an exemption, because a
// control wired to nothing produces no effect in either state.
async function displacedStateProbe(page, route, target) {
  await gotoSettled(page, `${BASE}${route}`).catch(() => {});
  const anchor = await resolveControlIndex(page, { tag: target.tag, text: target.text }, target.index);
  if (anchor < 0) return { attempted: false, changed: false, sibling: null, evidence: null };
  const candidates = (await siblingCandidates(page, anchor)).filter((item) => item.text && !DESTRUCTIVE_TEXT.test(item.text)).slice(0, 2);
  for (const sibling of candidates) {
    await gotoSettled(page, `${BASE}${route}`).catch(() => {});
    const siblingIndex = await resolveControlIndex(page, sibling);
    if (siblingIndex < 0) continue;
    const displaced = await clickAndObserve(page, siblingIndex);
    if (displaced.error) continue;
    // The displacing click can itself re-render the group, so re-resolve before the retry.
    const targetIndex = await resolveControlIndex(page, { tag: target.tag, text: target.text });
    if (targetIndex < 0) continue;
    const retry = await clickAndObserve(page, targetIndex);
    if (observable(retry)) {
      return { attempted: true, changed: true, sibling: sibling.text, evidence: retry.requestSeen || retry.navigationSeen || `dom mutations ${retry.domMutations}` };
    }
  }
  return { attempted: candidates.length > 0, changed: false, sibling: candidates[0]?.text || null, evidence: null };
}

async function probeControls(page, route) {
  await page.setViewportSize({ width: 1280, height: 900 });
  // A provider-identity surface refuses a staff UAT session outright. Capture that refusal from the
  // identity endpoint itself rather than from rendered copy, so the signal cannot be reached by any
  // route whose controls are genuinely probeable.
  const identityRefusals = [];
  const onIdentityResponse = (response) => {
    if (response.url().includes("/api/identity-session") && [401, 403].includes(response.status())) {
      identityRefusals.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    }
  };
  page.on("response", onIdentityResponse);
  await gotoSettled(page, `${BASE}${route}`);
  page.off("response", onIdentityResponse);
  const descriptors = await page.locator("button,a[href]").evaluateAll((els) => els.map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 100),
    href: el.tagName === "A" ? el.getAttribute("href") : null,
    disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    hidden: !(el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none"),
  }))).catch(() => []);
  const targets = descriptors.filter((d) => !d.disabled && !d.hidden).slice(0, MAX_CONTROLS_PER_ROUTE);

  // Record every control this actor could not reach instead of dropping them, so the report shows
  // the exact size of the unexercised surface rather than hiding it behind a smaller probe count.
  if (identityRefusals.length) {
    return {
      identityGated: true,
      identityEvidence: identityRefusals[0],
      controls: targets.map((target) => ({ ...target, destructive: DESTRUCTIVE_TEXT.test(target.text || ""), identityGated: true, result: CONTROL_RESULT.identityGated, error: identityRefusals[0] })),
    };
  }

  const results = [];
  for (const target of targets) {
    const linkResult = linkWiringResult(target, route);
    if (linkResult) { results.push({ ...target, destructive: false, mutationAttempt: null, requestSeen: null, dialogSeen: null, changed: false, ...linkResult }); continue; }

    await gotoSettled(page, `${BASE}${route}`).catch(() => {});
    const index = await resolveControlIndex(page, { tag: target.tag, text: target.text }, target.index);
    if (index < 0) { results.push({ ...target, indexDrift: true, result: CONTROL_RESULT.indexDrift, error: "control could not be re-resolved on reload" }); continue; }
    const locator = page.locator("button,a[href]").nth(index);
    if (!await locator.isVisible().catch(() => false)) { results.push({ ...target, result: "skipped_not_visible" }); continue; }

    const destructive = DESTRUCTIVE_TEXT.test(target.text || `${target.tag}#${target.index}`);
    const evidence = await clickAndObserve(page, index);
    // Only a control that produced nothing at all earns a second, harder pass. A destructive
    // control is never clicked twice.
    const needsDisplacement = !observable(evidence) && !evidence.validationBlocked && !evidence.error && !destructive;
    const displacement = needsDisplacement ? await displacedStateProbe(page, route, target) : null;
    const result = classifyControl({ ...evidence, destructive, displacement });
    results.push({ ...target, destructive, result, ...evidence, displacement });
  }
  return { identityGated: false, identityEvidence: null, controls: results };
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
      controlFailures: controls.flatMap((r) => r.controls).filter((c) => isControlFailure(c.result)).length,
      // Every non-plain wiring verdict is counted here so a growing exemption surface is visible in
      // the summary rather than only inside the evidence artifact.
      controlsIdempotentProven: controls.flatMap((r) => r.controls).filter((c) => c.result === CONTROL_RESULT.wiredIdempotent).length,
      controlsValidationBlocked: controls.flatMap((r) => r.controls).filter((c) => c.result === CONTROL_RESULT.wiredValidationBlocked).length,
      controlsIdentityGated: controls.flatMap((r) => r.controls).filter((c) => c.result === CONTROL_RESULT.identityGated).length,
      identityGatedRoutes: controls.filter((r) => r.identityGated).map((r) => `${r.actor} ${r.route} (${r.identityEvidence})`),
      roles: ["guest_customer", ...STAFF_ROLES.map((r) => r.role)],
      mutationsExecuted: 0,
      phase: controls.length ? "controls" : "visual",
    },
    visualFailures: [...visual, ...roleCoverage].filter((r) => r.failures.length),
    controlFailures: controls.flatMap((r) => r.controls.map((c) => ({ actor: r.actor, route: r.route, ...c }))).filter((c) => isControlFailure(c.result)),
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
        controls.push({ actor: actor.role, route, ...(await probeControls(page, route)) });
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
    console.log(`UI closure passed: no broken images/overflow/clipped controls and every probed enabled control produced observable wiring evidence (${report.summary.controlsIdempotentProven} proven only after state displacement, ${report.summary.controlsValidationBlocked} proven by constraint validation, ${report.summary.controlsIdentityGated} unreachable behind an identity boundary). Mutating requests were blocked before execution.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
