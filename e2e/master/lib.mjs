// Shared helpers for the staging master E2E suite (run on GitHub Actions against the deployed staging origin).
// Secrets arrive only through the environment. They are never typed into a page (so they never appear in a
// screenshot or video) and every text artefact passes through redact() before it is written.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE = String(process.env.STAGING_URL || "https://pawspace-staging.karthik-fce.workers.dev").replace(/\/$/, "");
export const OUT = process.env.MASTER_OUT || "artifacts/master";
const CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "");
const SECRETS = [CODE, process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID, process.env.STAGING_D1_ID].filter(v => v && v.length >= 6);
export const hasAccessCode = () => CODE.length >= 32;

export function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  for (const secret of SECRETS) text = text.split(secret).join("[REDACTED]");
  // Playwright call logs echo request headers: never keep session cookies or auth headers.
  text = text.replace(/(cookie|authorization):[^\n"]*/gi, "$1: [REDACTED]").replace(/(pawspace_[a-z_]*=)[^;\s"\\]+/gi, "$1[REDACTED]");
  return text;
}

mkdirSync(OUT, { recursive: true });
export function writeJson(name, value) { writeFileSync(join(OUT, name), redact(value)); }
export function record(row) { appendFileSync(join(OUT, "results.jsonl"), redact({ t: new Date().toISOString(), ...row }).replace(/\n/g, " ") + "\n"); }
export function finding(row) { appendFileSync(join(OUT, "findings.jsonl"), redact({ t: new Date().toISOString(), ...row }).replace(/\n/g, " ") + "\n"); }

/** HEADED=1 opens a visible Chromium window (e.g. on a Mac to watch the run); SLOWMO=<ms> slows each action. */
export async function launch({ slowMo = 0 } = {}) {
  const headed = process.env.HEADED === "1";
  const executablePath = process.env.PW_CHROMIUM_EXECUTABLE_PATH || undefined; // local containers with a preinstalled Chromium
  return chromium.launch({ headless: !headed, executablePath, slowMo: Number(process.env.SLOWMO || 0) || slowMo || (headed ? 250 : 0) });
}

/** One recorded journey: numbered screenshots, optional video, API failures, console and page errors. */
export async function newFlow(browser, name, { mobile = false, geolocation = null, video = false } = {}) {
  const dir = join(OUT, "shots", name);
  mkdirSync(dir, { recursive: true });
  const opts = mobile
    ? { ...devices["Pixel 7"], locale: "en-IN", timezoneId: "Asia/Kolkata" }
    : { viewport: { width: 1366, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" };
  if (geolocation) Object.assign(opts, { geolocation, permissions: ["geolocation"] });
  if (video) opts.recordVideo = { dir: join(dir, "video"), size: mobile ? { width: 412, height: 915 } : { width: 1366, height: 900 } };
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const log = { name, steps: [], apiFailures: [], consoleErrors: [], pageErrors: [] };
  let n = 0;
  page.on("response", async res => {
    const url = res.url();
    if (!url.startsWith(BASE) || !url.includes("/api/") || res.status() < 400) return;
    let body = ""; try { body = (await res.text()).slice(0, 500); } catch {}
    log.apiFailures.push({ at: n, method: res.request().method(), url: url.replace(BASE, ""), status: res.status(), body });
  });
  page.on("console", m => { if (m.type() === "error") log.consoleErrors.push({ at: n, text: m.text().slice(0, 300) }); });
  page.on("pageerror", e => log.pageErrors.push({ at: n, text: String(e).slice(0, 300) }));
  const flow = {
    name, dir, context, page, log,
    async shot(label, { fullPage = true } = {}) {
      n += 1;
      const file = `${String(n).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
      await page.screenshot({ path: join(dir, file), fullPage }).catch(() => page.screenshot({ path: join(dir, file) }).catch(() => {}));
      log.steps.push({ n, label, file, url: page.url().replace(BASE, "") });
      return join("shots", name, file);
    },
    note(text, extra = {}) { log.steps.push({ n, note: text, ...extra }); console.log(redact(`[${name}] ${text}`)); },
    async close() { writeFileSync(join(dir, "log.json"), redact(log)); await context.close().catch(() => {}); },
  };
  return flow;
}

export async function settle(page, ms = 800) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function post(context, path, data) {
  const res = await context.request.post(BASE + path, { headers: { origin: BASE, "content-type": "application/json" }, data, timeout: 30_000 });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status(), body };
}

/** Staff session through the real /api/staging-login (same call certification uses). */
export async function staffSession(context, email) {
  const r = await post(context, "/api/staging-login", { action: "login", email, code: CODE });
  if (r.status !== 200) throw new Error(`staff sign-in ${email} refused: HTTP ${r.status} ${redact(r.body)}`);
  return r;
}
/**
 * Customer session for persona "customer-a" | "customer-b".
 * MASTER_CUSTOMER_MODE=otp (set by the staging workflow): signs in a run-scoped customer through the real sandbox
 * customer OTP API, so a master run never shares a login with human testers (a new sign-in supersedes every other
 * session of the same customer). Otherwise: the fixed synthetic persona via /api/uat-customer-switch (no OTP).
 */
export const runPhone = (slot) => `97${String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || "0000000").slice(-7).padStart(7, "0")}${slot}`;
export async function customerSession(context, persona = "customer-a") {
  if (process.env.MASTER_CUSTOMER_MODE === "otp") return otpCustomerSession(context, runPhone(persona === "customer-b" ? 2 : 1), `Master E2E ${persona === "customer-b" ? "B" : "A"}`);
  const r = await post(context, "/api/uat-customer-switch", { code: CODE, persona });
  if (r.status !== 200) throw new Error(`test customer ${persona} refused: HTTP ${r.status} ${redact(r.body)}`);
  return r.body?.data;
}
/** Real sandbox customer OTP (request → on-screen/sandbox code → verify). */
export async function otpCustomerSession(context, phone, name = "Master E2E") {
  const r1 = await post(context, "/api/customer-otp", { action: "request", phone });
  const challengeId = r1.body?.data?.challengeId, code = r1.body?.data?.sandboxCode;
  if (r1.status !== 200 || !challengeId || !code) throw new Error(`customer OTP request refused: HTTP ${r1.status} ${redact(r1.body)}`);
  const r2 = await post(context, "/api/customer-otp", { action: "verify", challengeId, code, name });
  if (r2.status !== 200) throw new Error(`customer OTP verify refused: HTTP ${r2.status} ${redact(r2.body)}`);
  return { ...r2.body?.data, phone };
}
/** Any live provider without OTP through /api/uat-provider-switch. */
export async function providerSession(context, providerId) {
  const r = await post(context, "/api/uat-provider-switch", { providerId, code: CODE });
  if (r.status !== 200) throw new Error(`provider switch ${providerId} refused: HTTP ${r.status} ${redact(r.body)}`);
  return r.body?.data;
}
export async function dismissCookies(page) {
  await page.getByRole("button", { name: "Essential only" }).first().click({ timeout: 3000 }).catch(() => {});
}

/** Read-only SQL against the staging D1 through the Cloudflare API. Only single SELECT/WITH/PRAGMA statements. */
export async function d1(sql, params = []) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN, db = process.env.STAGING_D1_ID;
  if (!acct || !token || !db) return { skipped: "Cloudflare D1 read credentials not configured" };
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(SELECT|WITH|PRAGMA)\b/i.test(trimmed) || trimmed.includes(";")) throw new Error("d1(): read-only single statement only");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${db}/query`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: trimmed, params }), signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) return { error: `HTTP ${res.status}`, detail: redact(body.errors || body).slice(0, 400) };
  return body.result?.[0]?.results || [];
}

/** IST date string N days from today. */
export const isoDay = (days) => { const d = new Date(Date.now() + 5.5 * 3600_000); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

/**
 * Complete a Razorpay TEST checkout (opened by the app) with Netbanking → test bank → "Success".
 * Ported from e2e/checkout-provider-webhook-proof-736.spec.ts, which proved this path on a hosted worker.
 */
export async function payRazorpayTestNetbanking(page, { phone = "9000000841", timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let netbanking = false, bank = false;
  while (Date.now() < deadline) {
    const frames = page.frames().filter(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
    let overlay = false;
    for (const frame of frames) {
      try {
        const o = frame.locator('[data-testid="contact-overlay-container"]').first();
        if (!(await o.isVisible().catch(() => false))) continue;
        overlay = true;
        const mobile = o.locator('[data-testid="contactNumber"], input[name="contact"], input[placeholder="Mobile number"]').first();
        await mobile.fill(phone, { timeout: 5000 });
        await o.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 5000 });
        await o.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
      } catch {}
    }
    if (overlay) { await page.waitForTimeout(500); continue; }
    for (const frame of frames) {
      try {
        if (!netbanking) {
          const nb = frame.locator('[data-testid="netbanking"]').first();
          if (await nb.isVisible().catch(() => false)) { await nb.click({ timeout: 5000 }); netbanking = true; await page.waitForTimeout(700); continue; }
        }
        if (netbanking && !bank) {
          const search = frame.locator('input[placeholder*="bank" i],input[aria-label*="bank" i]').first();
          if (await search.isVisible().catch(() => false)) await search.fill("HDFC Bank").catch(() => {});
          for (const choice of [frame.getByRole("button", { name: /HDFC Bank/i }).first(), frame.locator('[data-value="HDFC"], [data-testid="HDFC"]').first(), frame.getByText(/^HDFC Bank$/i).first(), frame.getByText(/^HDFC$/i).first()]) {
            if (!(await choice.isVisible().catch(() => false))) continue;
            await choice.click({ timeout: 5000 }); bank = true; await page.waitForTimeout(900); break;
          }
          if (bank) continue;
        }
      } catch {}
    }
    for (const p of page.context().pages()) {
      for (const surface of [p, ...p.frames()]) {
        try {
          const ok = surface.getByRole("button", { name: /^Success$/i }).first();
          if (await ok.isVisible().catch(() => false)) { await ok.click({ timeout: 5000 }); return { ok: true, netbanking, bank }; }
        } catch {}
      }
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, netbanking, bank, error: "Razorpay Test Netbanking success control was not reached" };
}

export function readJsonl(name) {
  const p = join(OUT, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Booking hand-off between suites (customer suites create, partner/staff/ledger suites consume). */
export function saveBooking(row) { appendFileSync(join(OUT, "bookings.jsonl"), redact({ t: new Date().toISOString(), ...row }).replace(/\n/g, " ") + "\n"); }
export function readBookings(filter = () => true) { return readJsonl("bookings.jsonl").filter(filter); }

/** JSON API call inside a signed-in browser context (same cookies as the page). */
export async function api(context, method, path, data, { timeout = 30_000 } = {}) {
  const opts = { headers: { origin: BASE, "content-type": "application/json" }, timeout };
  if (data !== undefined) opts.data = data;
  const res = await context.request.fetch(BASE + path, { method, ...opts });
  let body = null; const text = await res.text().catch(() => "");
  try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
  return { status: res.status(), body };
}

/** Per-suite date windows (days from today, IST) so suites never compete for the same provider capacity. */
export const WINDOWS = { boarding: [40, 70], sitting: [71, 95], taxi: [96, 110], services: [111, 130], partnerNearTerm: [1, 4] };

/** The commit the live staging version was deployed from (read-only Cloudflare API; deploy message "staging <sha>"). */
export async function deployedSha(script = "pawspace-staging") {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) return { skipped: "no Cloudflare credentials" };
  const cf = async path => { const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }); const b = await r.json().catch(() => ({})); if (!r.ok || b.success !== true) throw new Error(`Cloudflare ${path.split("/").slice(0, 4).join("/")} HTTP ${r.status}`); return b.result; };
  try {
    const deployments = await cf(`/workers/scripts/${script}/deployments`);
    const active = deployments?.deployments?.[0];
    const versionId = active?.versions?.[0]?.version_id;
    const version = versionId ? await cf(`/workers/scripts/${script}/versions/${versionId}`) : null;
    const message = String(version?.metadata?.annotations?.["workers/message"] || version?.annotations?.["workers/message"] || "");
    return { versionId, createdOn: active?.created_on, message, sha: (message.match(/[0-9a-f]{40}/) || [])[0] || null };
  } catch (e) { return { error: String(e.message || e) }; }
}
