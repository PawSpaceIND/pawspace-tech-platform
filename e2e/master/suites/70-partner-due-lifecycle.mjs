// Partner half of the near-term bookings that earlier master runs make (suites 20/30/40 save them with nearTerm:true).
// Partner actions are time-gated on staging (wall clock, no service-clock override), so this suite runs LATER, on a
// schedule, in its own workflow run. It cannot read that run's bookings.jsonl, so it DISCOVERS the bookings read-only
// from staging D1 - paid Boarding / Pet Sitting / Pet Taxi bookings of run-scoped master customers (phone 97…, OTP
// customer id, name "Master E2E…") - and drives every due one through the V2 partner app as its own provider:
//   Pet Taxi     accept → confirm the reserved fleet car → owner pickup (from start − 30 min) → start trip → 2 route
//                samples + before picture (verified by staff in the Booking Command Center, then recorded) → arrive →
//                drop-off + after picture → complete; the customer then pays the final balance ("Pay balance", Razorpay
//                TEST) → the driver's earnings → D1 books (schedule paid, reconciliation, owner payout, journal).
//   Pet Sitting  accept → check in at the doorstep inside the care window (geofenced) → care updates → care-update
//                photo verified in the Booking Command Center (PARTNER-02) and recorded → check out → earnings →
//                customer view → D1.
//   Boarding     accept → check in inside the stay window → meal + play → daily photo verified in the Booking Command
//                Center and recorded → check out → earnings (partner app + host Settlement tab) → customer view → D1.
// On every proof page the incident form is filled and checked but NEVER submitted (PARTNER-04). Nothing is created and
// only master-run synthetic bookings are touched. With nothing due it records one SKIPPED row per service listing the
// upcoming near-term bookings and the UTC time each becomes actionable (the main session schedules the run from it).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BASE, OUT, launch, newFlow, settle, api, d1, staffSession, otpCustomerSession, providerSession, dismissCookies,
  payRazorpayTestNetbanking, record, finding, writeJson, hasAccessCode,
} from "../lib.mjs";
import {
  LABEL, SERVICES, WINDOW_RULES, MIN, tablesSql, discoverySql, discoveryParams, classifyBooking, byUrgency, scheduleEntry,
  readbackQueries, evaluateReadback, providerJobCountSql, istDate, nearby, haversineMeters, makePng, oneLine, short, escRe,
} from "./_70-partner-due-lifecycle-helpers.mjs";

const SUITE = "70-partner-due-lifecycle";
const RUN = String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || Date.now()).slice(-7);
const STARTED = Date.now();
/** No new lifecycle is started after this (each takes ~4-7 min; the runner kills a suite at 40 min). */
const BUDGET_MS = Number(process.env.MASTER_DUE_BUDGET_MIN || 26) * MIN;
const MAX_PER_SERVICE = Math.max(1, Number(process.env.MASTER_DUE_MAX_PER_SERVICE || 2));
const NAME_PREFIX = process.env.MASTER_DUE_NAME_PREFIX || "Master E2E";
/** Finance/Admin are MFA-gated on staging; the founder (permissions ["*"]) or a manager verifies proof. */
const STAFF = ["founder@pawspace.in", "jyoti.manager39@tkpetcare.in"];
const HOME = { latitude: 12.9719, longitude: 77.6412 }; // 100 Feet Road, Indiranagar: the address the booking suites use
const PROOF = {
  boarding: { endpoint: "/api/boarding-proof", scopeKey: "stayId" },
  pet_sitting: { endpoint: "/api/sitting-proof", scopeKey: "bookingId" },
  pet_taxi: { endpoint: "/api/taxi-proof", scopeKey: "bookingId" },
};
const out = { suite: SUITE, run: RUN, startedAt: new Date(STARTED).toISOString(), windows: WINDOW_RULES, discovery: null, lifecycles: [] };
const findingTitles = new Set();
const rec = (row) => record({ suite: SUITE, evidence: [], ...row });
const fnd = (row) => { if (findingTitles.has(row.title)) return; findingTitles.add(row.title); finding({ suite: SUITE, evidence: [], ...row }); };
const enc = encodeURIComponent;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ok2xx = (res) => Boolean(res) && res.status >= 200 && res.status < 300;
const key = (b, what) => `m70-${RUN}-${what}-${b.bookingId}`;
const svc = (b) => ({ boarding: "boarding", pet_sitting: "sitting", pet_taxi: "taxi" })[b.service];
const combo = (b) => `${b.bookingId} · ${b.providerId} · ${b.packageCode || b.packageName} · ${b.startIso} → ${b.endIso}`;
const rupees = (text) => { const m = String(text || "").match(/₹\s*([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, "")) : null; };
/** One-line summary of an API answer; never carries an upload token. */
function brief(res) {
  if (!res) return "no response";
  let shown = res.body;
  if (shown && typeof shown === "object") {
    if (shown.error) shown = { error: shown.error, code: shown.code };
    else if (shown.data && typeof shown.data === "object" && !Array.isArray(shown.data)) { const { upload, token, ...rest } = shown.data; shown = rest; }
  }
  return `HTTP ${res.status}${res.via && res.via !== "ui" ? ` (${res.via})` : ""} ${oneLine(typeof shown === "string" ? shown : JSON.stringify(shown ?? res.error ?? ""), 240)}`;
}

let browser = null;
const getBrowser = async () => (browser ??= await launch());

// ---------------------------------------------------------------------------------------------------------------
// UI plumbing: every partner-app action is a click whose API call is captured; a control that is not usable is
// reported as a UI issue and the same governed call the page would make is sent instead (result then PARTIAL).
// ---------------------------------------------------------------------------------------------------------------
function nextResponse(page, path, { method = "POST", match, timeout = 30_000 } = {}) {
  return page.waitForResponse(r => r.url().startsWith(BASE) && new URL(r.url()).pathname === path && r.request().method() === method && (!match || match(r.request().postData() || "")), { timeout })
    .then(async r => { const text = await r.text().catch(() => ""); let body = null; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); } return { status: r.status(), body }; })
    .catch(e => ({ status: 0, body: null, error: `no ${method} ${path} observed (${oneLine(e?.message || e, 100)})` }));
}
async function waitEnabled(locator, ms = 15_000) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return "enabled";
    await sleep(400);
  }
  return (await locator.isVisible().catch(() => false)) ? "disabled" : "not visible";
}
async function press(t, flow, { step, locator, why, path, match, fallback, method = "POST", optional = false }) {
  const state = locator ? await waitEnabled(locator) : why || "not offered";
  let res;
  if (state === "enabled") {
    const wait = nextResponse(flow.page, path, { method, match });
    await locator.click({ timeout: 10_000 }).catch(e => t.uiIssues.push(`${step}: click failed (${oneLine(e.message, 90)})`));
    res = await wait; res.via = "ui";
    await settle(flow.page, 900);
  } else {
    t.uiIssues.push(`${step}: UI control ${state}`);
    res = fallback ? await fallback() : { status: 0, body: { error: `UI control ${state}` } };
    res.via = fallback ? "api-fallback" : "ui";
  }
  t.step(step, res, { optional });
  return res;
}
function tracker(b) {
  return {
    b, steps: [], uiIssues: [], evidence: [], outcome: { completed: false },
    step(name, res, extra = {}) {
      const ok = ok2xx(res);
      this.steps.push({ step: name, ok, http: res?.status ?? 0, via: res?.via || "ui", info: brief(res), ...extra });
      console.log(`${ok ? "ok  " : "FAIL"} [${b.bookingId}] ${name} ${brief(res)}`);
      return ok;
    },
    info(name, ok, detail, extra = {}) {
      this.steps.push({ step: name, ok, info: oneLine(detail, 300), ...extra });
      console.log(`${ok ? "ok  " : "FAIL"} [${b.bookingId}] ${name} ${oneLine(detail, 300)}`);
    },
  };
}
const summary = (t) => JSON.stringify({ steps: t.steps.map(s => `${s.ok ? "✓" : "✗"} ${s.step}${s.via && s.via !== "ui" ? ` [${s.via}]` : ""}: ${s.info}`), uiIssues: t.uiIssues }).slice(0, 2400);
async function goto(flow, path) {
  await flow.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  if (!flow.cookiesDone) { await dismissCookies(flow.page); flow.cookiesDone = true; }
  await settle(flow.page, 1800);
}
/** Unexpected 5xx and uncaught page errors seen by a flow are defects in their own right. */
async function closeFlow(flow, journeyName) {
  if (!flow) return;
  for (const f of flow.log.apiFailures.filter(x => x.status >= 500).slice(0, 3)) fnd({ severity: /lifecycle|proof|checkout|stays|booking|payment|partner/.test(f.url) ? "P1" : "P2", area: "API", persona: journeyName.split(" ")[0], flow: journeyName, title: `HTTP ${f.status} from ${f.method} ${f.url.split("?")[0]} during ${journeyName}`, steps: journeyName, expected: "no server error", actual: `${f.status} ${oneLine(f.body, 240)}`, evidence: [] });
  for (const e of flow.log.pageErrors.filter(x => !/razorpay/i.test(x.text)).slice(0, 2)) fnd({ severity: "P2", area: "Frontend", persona: journeyName.split(" ")[0], flow: journeyName, title: `Uncaught page error during ${journeyName}: ${oneLine(e.text, 80)}`, steps: journeyName, expected: "no uncaught error", actual: oneLine(e.text, 300), evidence: [] });
  await flow.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions: the provider through /api/uat-provider-switch, the customer re-signed-in through the sandbox OTP (one
// context per customer, so no second session ever supersedes it), staff through /api/staging-login.
// ---------------------------------------------------------------------------------------------------------------
async function signInProvider(t, flow) {
  try { await providerSession(flow.context, t.b.providerId); t.info("provider session", true, t.b.providerId); return true; }
  catch (e) { t.outcome = { blocked: true, note: `due (${t.b.reason}) but its provider ${t.b.providerId} cannot be signed in: ${oneLine(e.message, 260)}` }; t.info("provider session", false, e.message); return false; }
}
function customerOf(t) {
  let flow = null;
  return {
    async get() {
      if (flow) return flow;
      flow = await newFlow(await getBrowser(), `70-${svc(t.b)}-${short(t.b.bookingId)}-customer`);
      await otpCustomerSession(flow.context, t.b.phone, t.b.customerName || NAME_PREFIX);
      return flow;
    },
    async close() { await closeFlow(flow, `Customer ${LABEL[t.b.service]} ${t.b.bookingId}`); flow = null; },
  };
}
let staffFlow = null, staffWho = null, staffRefusals = [];
async function getStaff() {
  if (staffFlow) return staffFlow;
  const flow = await newFlow(await getBrowser(), "70-staff-proof-verification");
  for (const email of STAFF) {
    try { await staffSession(flow.context, email); staffWho = email; break; } catch (e) { staffRefusals.push(oneLine(e.message, 160)); }
  }
  if (!staffWho) { await flow.close(); throw new Error(`harness: staff sign-in refused (${staffRefusals.join(" | ")})`); }
  return (staffFlow = flow);
}

/** The provider opens the job from the V2 partner app home ("Your service workspaces"), as a partner would. */
async function openFromPartnerApp(t, flow, workspace) {
  const b = t.b, { page } = flow;
  await goto(flow, "/v2/partner");
  const link = page.locator(`section[aria-label="Other assigned services"] a[href*="bookingId=${enc(b.bookingId)}"]`).first();
  await link.waitFor({ state: "visible", timeout: 25_000 }).catch(() => {});
  const listed = await link.isVisible().catch(() => false);
  t.evidence.push(await flow.shot("partner-app-home"));
  if (listed) { await link.click().catch(() => {}); await page.waitForURL(u => String(u).includes(`/v2/partner/${workspace}`), { timeout: 20_000 }).catch(() => {}); }
  if (!page.url().includes(`/v2/partner/${workspace}`)) await goto(flow, `/v2/partner/${workspace}?bookingId=${enc(b.bookingId)}`);
  await settle(page, 1500);
  t.info("partner app lists the due job", listed, listed ? `"Open ${LABEL[b.service].toLowerCase()} job" on /v2/partner → /v2/partner/${workspace}` : "not listed under Your service workspaces - opened the workspace URL directly");
  if (!listed) {
    const feed = await api(flow.context, "GET", `/api/partner-job-feed?providerId=${enc(b.providerId)}`);
    const inFeed = JSON.stringify(feed.body || "").includes(b.bookingId);
    const count = await d1(providerJobCountSql, [b.startIso, b.providerId]);
    const c = Array.isArray(count) ? count[0] || {} : {};
    t.info("partner job feed", inFeed, `GET /api/partner-job-feed HTTP ${feed.status}: booking ${inFeed ? "present" : "absent"}; provider has ${c.n ?? "?"} bookings, ${c.older ?? "?"} scheduled before this one`);
    if (feed.status === 200 && !inFeed) fnd({ severity: "P2", area: "Partner app", persona: "Partner", flow: "Partner app home → Your service workspaces", title: Number(c.older) >= 500 ? "A provider's due job is missing from the partner app once they have 500+ earlier bookings" : "A paid, due job is missing from the partner app job feed", steps: `Sign in as ${b.providerId}; open /v2/partner (lib/partner-job-feed.ts reads canonical_bookings ORDER BY scheduled_start ASC LIMIT 500)`, expected: `${b.bookingId} (paid, due now) listed with an "Open … job" link`, actual: `absent from GET /api/partner-job-feed; provider has ${c.n ?? "?"} bookings, ${c.older ?? "?"} scheduled earlier`, evidence: t.evidence.slice(-1) });
  }
  return listed;
}

// ---------------------------------------------------------------------------------------------------------------
// Proof (PARTNER-02 / PARTNER-04): upload on the partner proof page, verify in the Booking Command Center, record.
// ---------------------------------------------------------------------------------------------------------------
async function uploadProof(t, flow, { service, scopeId, purpose, selectPurpose = false, label, color }) {
  const b = t.b, { page, context } = flow, { endpoint, scopeKey } = PROOF[service];
  const file = makePng(join(OUT, "proof-images", `${short(b.bookingId)}-${purpose}-${Date.now()}.png`), 96, 96, color);
  if (selectPurpose) await page.locator("select").filter({ has: page.locator(`option[value="${purpose}"]`) }).first().selectOption(purpose).catch(e => t.uiIssues.push(`${label}: purpose not selectable (${oneLine(e.message, 80)})`));
  const input = page.locator('input[type="file"]').first();
  if (await input.count()) {
    const prep = nextResponse(page, endpoint, { match: x => x.includes('"prepare_media"') });
    const put = nextResponse(page, endpoint, { method: "PUT", timeout: 45_000 });
    await input.setInputFiles(file);
    const p = await prep; p.via = "ui";
    if (!ok2xx(p)) { t.step(`${label}: register`, p); return { res: p }; }
    const u = await put; u.via = "ui";
    t.step(`${label} uploaded`, u);
    await settle(page, 1200);
    return { res: u, mediaId: u.body?.data?.mediaId || p.body?.data?.mediaId, mediaRef: u.body?.data?.mediaRef || p.body?.data?.mediaRef };
  }
  // No file input: the same two calls lib/partner-proof-client.ts makes (register, then PUT the bytes with the grant).
  t.uiIssues.push(`${label}: no file input on the proof page`);
  const bytes = readFileSync(file), sha256 = createHash("sha256").update(bytes).digest("hex");
  const p = await api(context, "POST", endpoint, { [scopeKey]: scopeId, action: "prepare_media", idempotencyKey: key(b, `media-${purpose}-${Date.now()}`), purpose, mimeType: "image/png", sizeBytes: bytes.length, sha256 });
  const mediaId = p.body?.data?.mediaId, token = p.body?.data?.upload?.token;
  if (!ok2xx(p) || !mediaId || !token) { p.via = "api-fallback"; t.step(`${label}: register`, p); return { res: p }; }
  const r = await context.request.fetch(`${BASE}${endpoint}?${scopeKey}=${enc(scopeId)}`, { method: "PUT", headers: { origin: BASE, "content-type": "image/png", "x-pawspace-media-id": mediaId, "x-pawspace-upload-token": token }, data: bytes, timeout: 60_000 });
  let body = null; try { body = await r.json(); } catch {}
  const u = { status: r.status(), body, via: "api-fallback" };
  t.step(`${label} uploaded`, u);
  return { res: u, mediaId, mediaRef: `media://asset/${mediaId}` };
}

/** Staff verify the partner's photo in the Booking Command Center "Service proof verification" panel. */
async function staffVerify(t, service, scopeId, mediaIds) {
  const b = t.b, { endpoint, scopeKey } = PROOF[service], reason = `Master E2E ${RUN}: synthetic partner-due proof checked`;
  const res = { via: "ui", responses: [], verified: [], problems: [], shot: null };
  let f;
  try { f = await getStaff(); } catch (e) { res.problems.push(oneLine(e.message, 240)); }
  if (f) {
    const { page, context } = f;
    const snapshot = async () => { const r = await api(context, "GET", `${endpoint}?${scopeKey}=${enc(scopeId)}`); return Array.isArray(r.body?.data?.media) ? r.body.data.media : []; };
    await goto(f, `/booking-command-center?bookingId=${enc(b.bookingId)}`);
    const panel = page.locator('section[aria-label="Service proof verification"]').first();
    await panel.waitFor({ state: "visible", timeout: 30_000 }).catch(() => res.problems.push("Service proof verification panel not shown"));
    const verify = panel.getByRole("button", { name: /^Verify$/ }).first();
    await verify.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    for (let i = 0; i < 4 && await verify.isVisible().catch(() => false); i++) {
      await panel.getByLabel(/Verification note/).fill(reason).catch(e => res.problems.push(`note: ${oneLine(e.message, 80)}`));
      const wait = nextResponse(page, endpoint, { match: x => x.includes("record_media_scan") });
      await verify.click({ timeout: 10_000 }).catch(e => res.problems.push(`Verify click: ${oneLine(e.message, 80)}`));
      const r = await wait; res.responses.push(r.status);
      if (!ok2xx(r)) { res.problems.push(`Verify → ${brief(r)}`); break; }
      await settle(page, 1500);
    }
    res.shot = await f.shot(`bcc-proof-${short(b.bookingId)}`);
    let media = await snapshot();
    const isVerified = (m) => m.scan_status === "clean" && m.access_status === "ready";
    const waiting = media.filter(m => mediaIds.includes(m.id) && m.access_status === "quarantined" && m.scan_status === "pending");
    if (waiting.length) {
      // The panel did not get to them: the same governed record_media_scan call it makes.
      res.via = "api-fallback";
      for (const m of waiting) {
        const r = await api(context, "POST", endpoint, { [scopeKey]: scopeId, action: "record_media_scan", idempotencyKey: key(b, `scan-${m.id}`), mediaRef: `media://asset/${m.id}`, scanResult: "clean", reason });
        res.responses.push(r.status);
        if (!ok2xx(r)) res.problems.push(`record_media_scan ${m.id} → ${brief(r)}`);
      }
      media = await snapshot();
    }
    res.verified = media.filter(isVerified).map(m => m.id);
  }
  const all = mediaIds.length > 0 && mediaIds.every(id => res.verified.includes(id));
  rec({ journey: `${LABEL[service]} proof photo verified in the Booking Command Center (PARTNER-02)`, combo: `${b.bookingId} · ${mediaIds.join(", ") || "no upload"} · ${staffWho || "no staff session"}`, result: !f ? "BLOCKED" : all ? (res.via === "ui" && !res.problems.length ? "PASS" : "PARTIAL") : "FAIL", detail: JSON.stringify({ via: res.via, responses: res.responses, verified: res.verified, problems: res.problems }).slice(0, 900), evidence: res.shot ? [res.shot] : [] });
  if (f && !all && res.responses.some(s => s >= 400)) fnd({ severity: "P1", area: `${LABEL[service]} proof`, persona: "Operations", flow: "Booking Command Center → Service proof verification", title: `Staff cannot verify a partner's ${LABEL[service]} proof photo`, steps: `${staffWho}: /booking-command-center?bookingId=${b.bookingId} → note → Verify`, expected: "photo verified (clean/ready)", actual: res.problems.join(" | ").slice(0, 400), evidence: res.shot ? [res.shot] : [] });
  t.info("staff verified the proof photo", all, `${res.via}: ${res.verified.length} verified ${res.problems.join(" | ")}`);
  return res;
}

const RECORD = {
  boarding: { option: "Select a verified daily stay photo", note: "Care update shown in the stay timeline", button: /Record daily update with verified proof/, action: "record_daily_update", step: "record the daily update with the verified photo", text: "Fed, played and settled (Master E2E synthetic)" },
  pet_sitting: { option: "Select a verified care update photo", note: null, button: /Record care update with verified proof/, action: "record_update", step: "record the care update with the verified photo", text: "Sitter proof update" },
  pet_taxi: { option: "Select a verified before picture", note: "Photo note", button: /Record verified before picture/, action: "record_photo_update", step: "record the verified before picture", text: "Pet loaded calmly (Master E2E synthetic)" },
};
async function recordVerified(t, flow, { service, scopeId, mediaRef }) {
  const b = t.b, { page } = flow, cfg = RECORD[service], { endpoint, scopeKey } = PROOF[service];
  const select = page.locator("select").filter({ has: page.locator("option", { hasText: cfg.option }) }).first();
  let selected = false;
  if (await select.isVisible().catch(() => false)) await select.selectOption(mediaRef).then(() => { selected = true; }).catch(e => t.uiIssues.push(`${cfg.step}: verified photo not in the picker (${oneLine(e.message, 80)})`));
  else t.uiIssues.push(`${cfg.step}: verified-photo picker not shown`);
  if (cfg.note) await page.getByPlaceholder(cfg.note).first().fill(cfg.text).catch(() => {});
  return press(t, flow, {
    step: cfg.step, locator: selected ? page.getByRole("button", { name: cfg.button }).first() : null, why: "verified photo not selectable",
    path: endpoint, match: x => x.includes(cfg.action),
    fallback: async () => api(flow.context, "POST", endpoint, { [scopeKey]: scopeId, action: cfg.action, idempotencyKey: key(b, `${cfg.action}-${istDate(Date.now())}`), mediaRef, note: cfg.text }),
  });
}
/** PARTNER-04: the incident form must be usable without a photo. Filled and checked, then cleared - never submitted. */
async function incidentFormCheck(t, flow, service) {
  const b = t.b, { page } = flow;
  const summaryBox = page.getByPlaceholder("What happened?").first(), submit = page.getByRole("button", { name: /Report governed incident/ }).first();
  const shown = await summaryBox.isVisible().catch(() => false);
  let before = null, after = null, shot = null;
  if (shown) {
    before = await submit.isEnabled().catch(() => null);
    await summaryBox.fill(`Master E2E ${RUN} synthetic check - NOT submitted`);
    after = await submit.isEnabled().catch(() => null);
    shot = await flow.shot("incident-form-filled-not-submitted");
    await summaryBox.fill("");
  }
  rec({ journey: `${LABEL[service]} incident form usable without a photo (PARTNER-04, not submitted)`, combo: b.bookingId, result: !shown ? "BLOCKED" : before === false && after === true ? "PASS" : "FAIL", detail: shown ? `"Report governed incident" disabled while empty: ${before === false}; enabled with a summary and no photo: ${after === true}. Cleared without submitting (no real incident is filed).` : "harness: incident form not found on the proof page", evidence: shot ? [shot] : [] });
}

// ---------------------------------------------------------------------------------------------------------------
// Customer side: care plan (precondition), paying an outstanding balance, the completed booking page.
// ---------------------------------------------------------------------------------------------------------------
async function submitCarePlan(t, cust, stayId) {
  const b = t.b, c = await cust.get();
  const plan = { vet: "Dr. Rao, Indiranagar Vet Clinic", emergencyContact: "Asha (synthetic contact)", feeding: "Twice a day", medication: "None", specialInstructions: `Master E2E partner-due run ${RUN}` };
  const res = b.service === "boarding"
    ? await api(c.context, "POST", "/api/boarding-stays", { stayId, action: "submit_care_plan", idempotencyKey: key(b, "care-plan"), carePlan: plan })
    : await api(c.context, "POST", "/api/sitting-lifecycle", { bookingId: b.bookingId, action: "submit_care_plan", idempotencyKey: key(b, "care-plan"), carePlan: { ...plan, homeAccess: "Key with the security desk (synthetic)" } });
  res.via = "customer api";
  return t.step("customer submits the missing care plan", res);
}
async function checkoutStatus(context, bookingId) {
  const r = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
  return { http: r.status, error: r.body?.error, ...(r.body?.data?.confirmation || {}) };
}
/** The customer pays what the booking page asks for (Pay balance / Pay securely → Razorpay TEST Netbanking → Success). */
async function payFromBookingPage(t, cust, stage) {
  const b = t.b, c = await cust.get(), { page, context } = c;
  const before = await checkoutStatus(context, b.bookingId);
  await goto(c, `/v2/booking?bookingId=${enc(b.bookingId)}`); await settle(page, 1500);
  const textBefore = oneLine(await page.locator("main").innerText().catch(() => ""), 900), shots = [await c.shot(`${stage}-before-payment`)];
  const button = page.getByRole("button", { name: /Pay balance|Pay securely/ }).first();
  await button.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  if (!(await button.isVisible().catch(() => false))) return { ok: false, before, textBefore, shots, reason: "no Pay balance / Pay securely button on /v2/booking" };
  const label = oneLine(await button.innerText().catch(() => ""), 80), shown = rupees(label);
  await button.click();
  let opened = false, alerts = [];
  for (const t0 = Date.now(); Date.now() - t0 < 60_000;) {
    await page.waitForTimeout(1000);
    opened = page.frames().some(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
    alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).filter(x => x.trim());
    if (opened || alerts.length) break;
  }
  if (!opened) { shots.push(await c.shot(`${stage}-checkout-not-opened`)); return { ok: false, before, label, shown, textBefore, shots, reason: alerts.join(" | ") || "Razorpay did not open in 60 s" }; }
  const paid = await payRazorpayTestNetbanking(page);
  let after = null;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(5000); after = await checkoutStatus(context, b.bookingId); if (after.paymentStage === "settled" || Number(after.amountDueNow) === 0) break; }
  await goto(c, `/v2/booking?bookingId=${enc(b.bookingId)}`); await settle(page, 2500);
  const textAfter = oneLine(await page.locator("main").innerText().catch(() => ""), 900);
  shots.push(await c.shot(`${stage}-after-payment`));
  const stillOffers = await page.getByRole("button", { name: /Pay balance|Pay securely/ }).first().isVisible().catch(() => false);
  return { ok: paid.ok && (after?.paymentStage === "settled" || Number(after?.amountDueNow) === 0), before, after, label, shown, paid, textBefore, textAfter, stillOffers, shots };
}
function recordPayment(t, p, { journeyName, expected }) {
  const b = t.b, due = Number(p.before?.amountDueNow);
  const amountOk = expected == null || (Number.isFinite(due) && Math.abs(due - expected) < 0.01);
  const buttonOk = p.shown == null || !Number.isFinite(due) || Math.abs(p.shown - due) < 0.01;
  const settled = p.after?.paymentStage === "settled" || Number(p.after?.amountDueNow) === 0;
  const detail = { before: p.before && { stage: p.before.paymentStage, dueNow: p.before.amountDueNow, payableNow: p.before.balancePayableNow, paid: p.before.amountPaid, payment: p.before.paymentStatus }, button: p.label, expected, razorpay: p.paid, after: p.after && { stage: p.after.paymentStage, dueNow: p.after.amountDueNow, payment: p.after.paymentStatus, booking: p.after.bookingStatus }, stillOffersPayment: p.stillOffers, reason: p.reason, pageAfter: (p.textAfter || p.textBefore || "").slice(0, 300) };
  const result = p.ok && amountOk && buttonOk && !p.stillOffers ? "PASS"
    : /not configured/i.test(p.reason || "") ? "ENV-GATED"
    : /Razorpay did not open/.test(p.reason || "") || (p.reason && !(Number(p.before?.amountDueNow) > 0)) ? "BLOCKED" : "FAIL";
  rec({ journey: journeyName, combo: `${b.bookingId} · expected ₹${expected ?? "?"}`, result, detail: `${result === "BLOCKED" ? "harness: " : ""}${JSON.stringify(detail)}`.slice(0, 1400), evidence: p.shots });
  if (!amountOk) fnd({ severity: "P0", area: "Payments", persona: "Customer", flow: journeyName, title: `${LABEL[b.service]} balance the customer is asked for differs from the balance the booking owes`, steps: `After the partner lifecycle of ${b.bookingId}, open /v2/booking as the customer`, expected: `₹${expected}`, actual: `amountDueNow ₹${p.before?.amountDueNow} (stage ${p.before?.paymentStage})`, evidence: p.shots });
  if (!buttonOk) fnd({ severity: "P1", area: "Payments", persona: "Customer", flow: journeyName, title: `${LABEL[b.service]} payment button shows a different amount than is due`, steps: `/v2/booking?bookingId=${b.bookingId}`, expected: `₹${due}`, actual: p.label, evidence: p.shots });
  if (p.reason && Number(p.before?.amountDueNow) > 0 && /no Pay/.test(p.reason) && p.before?.balancePayableNow !== false) fnd({ severity: "P1", area: "Payments", persona: "Customer", flow: journeyName, title: `Customer cannot pay the ${LABEL[b.service]} balance that is due`, steps: `/v2/booking?bookingId=${b.bookingId}`, expected: `Pay balance · ₹${p.before?.amountDueNow}`, actual: `${p.reason}; page: ${(p.textBefore || "").slice(0, 200)}`, evidence: p.shots });
  if (p.paid?.ok && !settled) fnd({ severity: "P1", area: "Payments", persona: "Customer", flow: journeyName, title: `${LABEL[b.service]} balance paid in Razorpay TEST is not settled on the booking within 2.5 minutes`, steps: `Pay balance for ${b.bookingId} → Netbanking → Success`, expected: "paymentStage settled, nothing due", actual: JSON.stringify(detail.after), evidence: p.shots });
  if (settled && p.stillOffers) fnd({ severity: "P1", area: "Payments", persona: "Customer", flow: journeyName, title: `Booking page still offers a payment after the ${LABEL[b.service]} balance was settled`, steps: `Pay the balance of ${b.bookingId}, reload /v2/booking`, expected: "no payment button", actual: (p.textAfter || "").slice(0, 300), evidence: p.shots });
  t.info(journeyName, p.ok && amountOk && buttonOk, `${p.label || p.reason || ""} → ${p.after?.paymentStage || "?"}`);
  return settled;
}
async function customerCompletedView(t, cust) {
  const b = t.b, c = await cust.get(), { page, context } = c;
  await goto(c, `/v2/booking?bookingId=${enc(b.bookingId)}`); await settle(page, 1500);
  const text = oneLine(await page.locator("main").innerText().catch(() => ""), 900), shot = await c.shot("customer-booking-completed");
  const st = await checkoutStatus(context, b.bookingId);
  const shows = /Status:\s*completed/i.test(text), offersPayment = await page.getByRole("button", { name: /Pay balance|Pay securely/ }).first().isVisible().catch(() => false);
  const pass = shows && st.bookingStatus === "completed" && !offersPayment;
  rec({ journey: `${LABEL[b.service]} customer sees the completed booking`, combo: b.bookingId, result: pass ? "PASS" : "FAIL", detail: JSON.stringify({ page: text.slice(0, 400), bookingStatus: st.bookingStatus, paymentStatus: st.paymentStatus, paymentStage: st.paymentStage, amountDueNow: st.amountDueNow, offersPayment }), evidence: [shot] });
  if (!pass && st.bookingStatus === "completed") fnd({ severity: "P2", area: "Customer booking page", persona: "Customer", flow: "Booking page after completion", title: `Customer's ${LABEL[b.service]} booking page does not show the completed booking cleanly`, steps: `/v2/booking?bookingId=${b.bookingId} after the partner completed it`, expected: "Status: completed and nothing to pay", actual: `${text.slice(0, 250)} | offers payment: ${offersPayment}`, evidence: [shot] });
}

// ---------------------------------------------------------------------------------------------------------------
// Partner earnings and the D1 books after completion.
// ---------------------------------------------------------------------------------------------------------------
async function partnerEarnings(t, flow, { hostSettlementTab = false } = {}) {
  const b = t.b, { page, context } = flow;
  let hostListed = null, hostShot = null;
  if (hostSettlementTab) {
    await goto(flow, `/v2/partner/host?bookingId=${enc(b.bookingId)}`);
    await page.locator("aside nav button").filter({ hasText: "Settlement" }).first().click({ timeout: 8000 }).catch(() => {});
    await settle(page, 1200);
    hostListed = await page.getByText(b.bookingId).first().isVisible().catch(() => false);
    hostShot = await flow.shot("host-settlement-tab");
  }
  await goto(flow, "/v2/partner");
  await page.locator('nav[aria-label="Partner mobile navigation"] button').filter({ hasText: "Earnings" }).first().click({ timeout: 10_000 }).catch(e => t.uiIssues.push(`Earnings tab: ${oneLine(e.message, 80)}`));
  await page.getByText("Settlement-controlled earnings").first().waitFor({ timeout: 20_000 }).catch(() => {});
  await settle(page, 2500);
  const text = oneLine(await page.locator("main").first().innerText().catch(() => ""), 2500), shot = await flow.shot("partner-earnings");
  const ws = await api(context, "GET", "/api/provider-workspace"), data = ws.body?.data || {}, e = data.earnings || {};
  const listedApi = [e.settlements, e.commissionOrders, e.payouts].some(list => JSON.stringify(list || []).includes(b.bookingId));
  const pending = (data.pendingProof || []).find(p => p.bookingId === b.bookingId) || null;
  // The "Service proof still outstanding" notice also names the booking: only a mention beyond it is an earnings row.
  const listedUi = text.split(b.bookingId).length - 1 > (pending ? 1 : 0);
  const [payout, commission] = await Promise.all([
    d1("SELECT provider_id,provider_net_payout,order_value FROM provider_payout_computations WHERE booking_id=?", [b.bookingId]),
    d1("SELECT provider_id,status,commission_amount FROM provider_order_commissions WHERE booking_id=?", [b.bookingId]),
  ]);
  const payoutRow = Array.isArray(payout) ? payout[0] || null : null, commissionRows = Array.isArray(commission) ? commission : null;
  const detail = { http: ws.status, engagement: data.engagement, onboarding: data.onboardingStatus, visible: e.visible, netPayout: e.netPayout, orders: e.orders, listedInEarningsApi: listedApi, listedOnEarningsTab: listedUi, hostSettlementTabLists: hostListed, pendingProof: pending, payoutComputation: payoutRow || (payout?.skipped ? "not checked" : payout?.error || "none"), orderCommission: commissionRows ? commissionRows[0] || "none" : commission?.skipped ? "not checked" : commission?.error, tab: text.slice(0, 360) };
  const listed = listedApi || listedUi || hostListed === true;
  let why = "";
  if (!listed && data.engagement === "contract" && b.service === "pet_taxi") why = `the driver is a salaried (full-time/contract) partner: lib/taxi-completion-finance.ts books the ride's payout for the vehicle owner ${payoutRow?.provider_id || "?"}, not the driver, so the driver's Earnings never list rides`;
  else if (!listed && data.engagement === "commission") why = "commission earnings list provider_order_commissions rows, which only syncCompletedCommissionOrders() creates when Finance opens /api/partner-finance";
  rec({ journey: `${LABEL[b.service]} partner earnings after completion`, combo: `${b.bookingId} · ${b.providerId} (${data.engagement || "?"})`, result: ws.status !== 200 ? "FAIL" : listed ? "PASS" : "PARTIAL", detail: `${why ? `${why}. ` : ""}${JSON.stringify(detail)}`.slice(0, 1800), evidence: [shot, hostShot].filter(Boolean) });
  if (pending) fnd({ severity: "P2", area: "Partner earnings", persona: "Partner", flow: "Partner app → Earnings after a governed completion", title: `Partner Earnings says service proof is still outstanding for a ${LABEL[b.service]} job completed with governed proof`, steps: `Complete ${b.bookingId} in the ${LABEL[b.service]} partner workspace (staff-verified proof recorded), open /v2/partner → Earnings`, expected: "no outstanding-proof warning for a job whose lifecycle already enforced its proof", actual: `"Service proof still outstanding … missing ${pending.missing.join(", ")} … holds up the settlement" (lib/provider-workspace.ts PROOF_REQUIREMENTS reads provider_job_proofs, which the ${LABEL[b.service]} workflow never writes)`, evidence: [shot] });
  if (!listed && data.engagement === "commission" && payoutRow && commissionRows && !commissionRows.length) fnd({ severity: "P2", area: "Partner earnings", persona: "Partner", flow: "Partner app → Earnings after completion", title: `A completed ${LABEL[b.service]} job is missing from the commission partner's Earnings`, steps: `Complete ${b.bookingId} as ${b.providerId}; open /v2/partner → Earnings`, expected: "the job listed with its commission (pending confirmation)", actual: `not in commissionOrders; no provider_order_commissions row (created only when Finance opens /api/partner-finance) although provider_payout_computations holds net ₹${payoutRow.provider_net_payout}`, evidence: [shot] });
}
async function readBackBooks(t, { pollMs = 0 } = {}) {
  const b = t.b, essential = { boarding: ["booking", "stay", "journal", "payoutComputation"], pet_sitting: ["booking", "events", "journal", "payoutComputation"], pet_taxi: ["booking", "trip", "schedule", "tripPayment", "journal"] }[b.service];
  let rb = {}, ev = null;
  for (const started = Date.now(); ;) {
    rb = {};
    for (const q of readbackQueries(b.service, b.bookingId)) rb[q.name] = await d1(q.sql, q.params);
    ev = evaluateReadback(b.service, rb, { providerId: b.providerId, total: b.total });
    if (!ev.checked || !ev.problems.length || Date.now() - started > pollMs) break;
    await sleep(15_000);
  }
  const errors = Object.entries(rb).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error} ${oneLine(v.detail, 120)}`);
  const essentialError = errors.some(x => essential.includes(x.split(":")[0]));
  const result = !ev.checked ? "SKIPPED" : essentialError ? "BLOCKED" : ev.problems.length ? "FAIL" : "PASS";
  rec({ journey: `${LABEL[b.service]} D1 books after the partner lifecycle`, combo: b.bookingId, result, detail: (!ev.checked ? "not checked: d1() skipped (no Cloudflare D1 credentials)" : JSON.stringify({ problems: ev.problems, errors, facts: ev.facts })).slice(0, 2000) });
  if (result === "FAIL") {
    const moneyWrong = ev.problems.some(p => /reconciliation captured|unbalanced/.test(p));
    fnd({ severity: moneyWrong ? "P0" : "P1", area: `${LABEL[b.service]} books`, persona: "Finance", flow: `${LABEL[b.service]} completion → canonical books`, title: `Completed ${LABEL[b.service]} booking is not fully reflected in the canonical books`, steps: `Partner lifecycle of ${b.bookingId} completed on staging; read staging D1 (read-only)${pollMs ? `, re-read for ${Math.round(pollMs / 60_000)} min` : ""}`, expected: "booking completed, payout computed, completion journal balanced, lifecycle events and payment state consistent", actual: ev.problems.join("; ").slice(0, 500), evidence: [] });
  }
  return ev;
}
/** A post-completion check that fails in the harness must not skip the others. */
async function guarded(t, journeyName, fn) {
  try { return await fn(); }
  catch (error) { rec({ journey: journeyName, combo: t.b.bookingId, result: "BLOCKED", detail: `harness: ${oneLine(error?.message || error, 300)}` }); return null; }
}
/** Record the main lifecycle row (and a finding for a refusal inside an open window). */
function recordLifecycle(t) {
  if (t.recorded) return t.recorded;
  const b = t.b, o = t.outcome, failing = t.steps.find(s => !s.ok && !s.optional);
  const fallbacks = t.steps.some(s => s.via === "api-fallback") || t.uiIssues.length > 0;
  const result = o.blocked ? "BLOCKED" : o.completed ? (fallbacks || t.steps.some(s => !s.ok) ? "PARTIAL" : "PASS") : o.continues ? "PARTIAL" : failing && failing.http >= 400 && !o.harness ? "FAIL" : "BLOCKED";
  const note = o.note || (result === "BLOCKED" ? `harness: stopped at "${failing?.step || "?"}" without a product answer` : "");
  rec({ journey: `${LABEL[b.service]} partner lifecycle as provider`, combo: combo(b), result, detail: `${note ? `${note} | ` : ""}${summary(t)}`, evidence: t.evidence.filter(Boolean).slice(0, 14) });
  t.recorded = result;
  if (result === "FAIL" && failing && failing.http) fnd({ severity: "P1", area: `${LABEL[b.service]} partner lifecycle`, persona: "Partner", flow: `${LABEL[b.service]} due booking inside its window`, title: `${LABEL[b.service]} partner step "${failing.step}" refused inside the open window`, steps: `As ${b.providerId} on /v2/partner (${b.reason}): ${t.steps.filter(s => s.ok).map(s => s.step).join(" → ")} → ${failing.step}`, expected: "the step succeeds (window open, preconditions met)", actual: failing.info, evidence: t.evidence.slice(-3) });
  return result;
}
const offerRefusal = (res) => /offer expired|No pending .*offer|not awaiting (host|sitter|driver) acceptance/i.test(JSON.stringify(res?.body || ""));
/** Why an acceptance was refused, when the assignment offer explains it (Boarding and Pet Taxi refusals reach the
 *  client only as a generic "Unable to update …" because authError redacts ungoverned 4xx bodies). */
async function acceptRefusal(t, res, flow) {
  const b = t.b;
  if (flow) t.evidence.push(await flow.shot("acceptance-refused"));
  const rows = b.groupId ? await d1("SELECT status,expires_at,provider_id,attempt_no FROM provider_assignment_offers WHERE group_id=?", [b.groupId]) : null;
  const offer = Array.isArray(rows) ? rows[0] || null : null;
  const generic = /^Unable to update/i.test(String(res?.body?.error || ""));
  if (generic) fnd({ severity: "P2", area: `${LABEL[b.service]} partner workspace`, persona: "Partner", flow: "Accept a job", title: `${LABEL[b.service]} acceptance refusal reaches the partner only as a generic "${res.body.error}"`, steps: `As ${b.providerId}, accept ${b.bookingId} on /v2/partner`, expected: "the reason (e.g. the offer expired, Operations will reassign)", actual: `HTTP ${res.status} ${JSON.stringify(res.body)}; offer ${JSON.stringify(offer)}`, evidence: t.evidence.slice(-1) });
  const expired = offer && (offer.status !== "pending" || Number(offer.expires_at) < Date.now() || offer.provider_id !== b.providerId);
  if (offerRefusal(res) || expired) return `acceptance refused (${brief(res)}); assignment offer ${offer ? `${offer.status}, expires ${new Date(Number(offer.expires_at)).toISOString()}, provider ${offer.provider_id}` : "row not readable"} - an unaccepted offer lapses acceptance_timeout_minutes after booking (commission hosts/sitters: 30 by default) and then needs Operations recovery, so the booking suites must accept near-term bookings right after payment`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Pet Taxi
// ---------------------------------------------------------------------------------------------------------------
async function runTaxi(b, t) {
  const pickup = b.pickup || b.doorstep || HOME, dropoff = b.dropoff || { latitude: pickup.latitude - 0.03, longitude: pickup.longitude - 0.015 };
  const driver = await newFlow(await getBrowser(), `70-taxi-${short(b.bookingId)}-driver`, { mobile: true, geolocation: nearby(pickup) });
  const cust = customerOf(t);
  try {
    if (!(await signInProvider(t, driver))) return;
    await openFromPartnerApp(t, driver, "driver");
    const { page, context } = driver, workspace = `/v2/partner/driver?bookingId=${enc(b.bookingId)}`, proofPage = `/v2/partner/driver/proof?bookingId=${enc(b.bookingId)}`;
    await page.getByRole("heading", { name: b.bookingId }).first().waitFor({ timeout: 25_000 }).catch(() => t.uiIssues.push("driver workspace did not render the trip"));
    t.evidence.push(await driver.shot("driver-workspace"));
    const read = async () => { const r = await api(context, "GET", `/api/taxi-lifecycle?bookingId=${enc(b.bookingId)}`); return Array.isArray(r.body?.data) ? r.body.data[0] || null : null; };
    const act = (step, name, action, extra = {}, optional = false) => press(t, driver, { step, optional, locator: page.getByRole("button", { name }).first(), path: "/api/taxi-lifecycle", match: x => x.includes(`"action":"${action}"`), fallback: async () => api(context, "POST", "/api/taxi-lifecycle", { bookingId: b.bookingId, action, idempotencyKey: key(b, action), ...extra }) });
    const toProofPage = async () => {
      const link = page.getByRole("link", { name: /Route · proof · incident/ }).first();
      if (await link.isVisible().catch(() => false)) { await link.click(); await page.waitForURL(u => String(u).includes("/driver/proof"), { timeout: 15_000 }).catch(() => {}); }
      if (!page.url().includes("/driver/proof")) { t.uiIssues.push("Route · proof · incident link not usable"); await goto(driver, proofPage); }
      await settle(page, 1500);
    };
    let completion = null, settledLogged = false, proofDone = false, afterDone = false, before = null;
    for (let guard = 0; guard < 18; guard++) {
      const row = await read();
      if (!row) { t.info("read trip", false, "GET /api/taxi-lifecycle returned no trip for the driver"); t.outcome = { harness: true, note: "driver could not read the trip" }; break; }
      const bs = String(row.status), ts = String(row.trip_status);
      let res = null;
      if (bs === "confirmed") { res = await act("accept trip", /^Accept trip$/, "accept"); const why = !ok2xx(res) && res.status >= 400 ? await acceptRefusal(t, res, driver) : null; if (why) { t.outcome = { blocked: true, note: why }; break; } }
      else if (bs === "assigned" && ts === "accepted") res = await act("confirm the reserved fleet car", /Confirm reserved fleet car|Assign UAT vehicle/, "assign_vehicle", { vehicleId: row.reserved_vehicle_id || row.vehicle_id || undefined });
      else if (ts === "vehicle_assigned") res = await act("confirm owner pickup (window open)", /Confirm owner pickup/, "confirm_pickup", { handoverMethod: "owner" });
      else if (ts === "pickup_confirmed") res = await act("start trip", /^Start trip$/, "start_trip");
      else if (ts === "in_progress" && !settledLogged) { settledLogged = true; await act("log pet settled", /^Log pet settled$/, "trip_event", { tripEventType: "pet_settled", detail: { message: "Pet settled safely in vehicle" } }, true); continue; }
      else if (ts === "in_progress" && !proofDone) {
        proofDone = true;
        await toProofPage();
        const snap = async () => (await api(context, "GET", `/api/taxi-proof?bookingId=${enc(b.bookingId)}`)).body?.data || {};
        let samples = (await snap()).routeSamples?.length || 0;
        for (const point of [pickup, dropoff]) {
          if (samples >= 2) break;
          await page.getByPlaceholder("Latitude").fill(String(point.latitude)).catch(() => {});
          await page.getByPlaceholder("Longitude").fill(String(point.longitude)).catch(() => {});
          await page.getByPlaceholder("Accuracy metres").fill("25").catch(() => {});
          const r = await press(t, driver, { step: `route sample ${samples + 1}`, locator: page.getByRole("button", { name: /Record sandbox location sample/ }).first(), path: "/api/taxi-proof", match: x => x.includes("record_location_sample"), fallback: async () => api(context, "POST", "/api/taxi-proof", { bookingId: b.bookingId, action: "record_location_sample", idempotencyKey: key(b, `sample-${samples + 1}`), latitude: point.latitude, longitude: point.longitude, accuracyMeters: 25 }) });
          if (!ok2xx(r)) break;
          samples += 1;
        }
        before = await uploadProof(t, driver, { service: "pet_taxi", scopeId: b.bookingId, purpose: "taxi_update", selectPurpose: true, label: "before picture", color: [30, 120, 200] });
        t.evidence.push(await driver.shot("driver-proof-before-picture"));
        if (before.mediaId) {
          const v = await staffVerify(t, "pet_taxi", b.bookingId, [before.mediaId]);
          if (v.verified.includes(before.mediaId)) { await page.reload({ waitUntil: "domcontentloaded" }); await settle(page, 2000); await recordVerified(t, driver, { service: "pet_taxi", scopeId: b.bookingId, mediaRef: before.mediaRef }); }
        }
        await incidentFormCheck(t, driver, "pet_taxi");
        await goto(driver, workspace);
        continue;
      }
      else if (ts === "in_progress") res = await act("arrive at drop-off", /^Arrive drop-off$/, "arrive_dropoff");
      else if (ts === "arrived_dropoff") res = await act("confirm drop-off", /Confirm drop-off/, "confirm_dropoff");
      else if (ts === "dropoff_confirmed" && !afterDone) {
        afterDone = true;
        await toProofPage();
        const after = await uploadProof(t, driver, { service: "pet_taxi", scopeId: b.bookingId, purpose: "taxi_dropoff", selectPurpose: true, label: "after picture", color: [200, 90, 60] });
        t.evidence.push(await driver.shot("driver-proof-after-picture"));
        if (after.mediaId) await staffVerify(t, "pet_taxi", b.bookingId, [after.mediaId]);
        await goto(driver, workspace);
        continue;
      }
      else if (ts === "dropoff_confirmed") { res = await act("complete trip (creates the final balance)", /Complete trip/, "complete_trip"); if (ok2xx(res)) completion = res.body?.data || null; }
      else if (ts === "completed") { t.outcome.completed = true; break; }
      else { t.info("unexpected trip state", false, `${bs}/${ts}`); t.outcome = { harness: true, note: `unexpected state ${bs}/${ts}` }; break; }
      if (res && res.status === 0 && (t.unobserved = (t.unobserved || 0) + 1) <= 2) continue;
      if (res && !ok2xx(res)) break;
    }
    await goto(driver, workspace);
    t.evidence.push(await driver.shot("driver-trip-final"));
    const final = await read();
    if (!t.outcome.completed && String(final?.trip_status) === "completed") t.outcome.completed = true;
    recordLifecycle(t);
    if (!t.outcome.completed) return;

    // The customer sees the final balance and pays it.
    const due = Number(completion?.amount ?? final?.tripPayment?.amount ?? b.taxi?.balance);
    t.outcome.note = `trip completed; final balance ₹${due} (${completion?.paymentStatus || final?.tripPayment?.status || "?"})`;
    // Only a ride-V2 booking (taxi_payment_schedules: 50% fee, balance at drop-off) has a customer-payable balance to compare.
    const already = final?.tripPayment?.status === "gateway_paid", payJourney = "Pet Taxi final balance paid by the customer (Pay balance)";
    let settled = already;
    if (!already && due > 0) settled = await guarded(t, payJourney, async () => recordPayment(t, await payFromBookingPage(t, cust, "taxi-balance"), { journeyName: payJourney, expected: b.taxi?.scheduleStatus && Number.isFinite(due) ? due : null }));
    else rec({ journey: payJourney, combo: b.bookingId, result: "SKIPPED", detail: already ? "final balance was already paid before this run" : `nothing due after completion (₹${due})` });
    // The capture's post-commit resolves the owner payout and the completion journal: give it time once paid.
    await guarded(t, "Pet Taxi D1 books after the partner lifecycle", () => readBackBooks(t, { pollMs: settled ? 120_000 : 0 }));
    await guarded(t, "Pet Taxi partner earnings after completion", () => partnerEarnings(t, driver));
    await guarded(t, "Pet Taxi customer sees the completed booking", () => customerCompletedView(t, cust));
  } finally {
    await closeFlow(driver, `Driver ${b.providerId} ${b.bookingId}`);
    await cust.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pet Sitting
// ---------------------------------------------------------------------------------------------------------------
async function runSitting(b, t) {
  const door = b.doorstep;
  const sitter = await newFlow(await getBrowser(), `70-sitting-${short(b.bookingId)}-sitter`, { mobile: true, geolocation: nearby(door || HOME) });
  const cust = customerOf(t);
  try {
    if (!(await signInProvider(t, sitter))) return;
    await openFromPartnerApp(t, sitter, "sitter");
    const { page, context } = sitter, workspace = `/v2/partner/sitter?bookingId=${enc(b.bookingId)}`;
    await page.getByRole("heading", { name: b.bookingId }).first().waitFor({ timeout: 25_000 }).catch(() => t.uiIssues.push("sitter workspace did not render the booking"));
    t.evidence.push(await sitter.shot("sitter-workspace"));
    const read = async () => { const r = await api(context, "GET", `/api/sitting-lifecycle?bookingId=${enc(b.bookingId)}`); return Array.isArray(r.body?.data) ? r.body.data[0] || null : null; };
    const act = (step, name, action, extra = {}, optional = false) => press(t, sitter, { step, optional, locator: page.getByRole("button", { name }).first(), path: "/api/sitting-lifecycle", match: x => x.includes(`"action":"${action}"`) && (!extra.careEventType || x.includes(extra.careEventType)), fallback: async () => api(context, "POST", "/api/sitting-lifecycle", { bookingId: b.bookingId, action, idempotencyKey: key(b, `${action}${extra.careEventType ? `-${extra.careEventType}` : ""}`), ...extra }) });
    let careLogged = false, proofDone = false, carePlanTried = false, balanceTried = false;
    for (let guard = 0; guard < 16; guard++) {
      const row = await read();
      if (!row) { t.info("read booking", false, "GET /api/sitting-lifecycle returned nothing for the sitter"); t.outcome = { harness: true, note: "sitter could not read the booking" }; break; }
      const status = String(row.status);
      let res = null;
      if (["confirmed", "awaiting_provider_acceptance", "reassignment_offered"].includes(status)) {
        res = await act("accept booking", /^(Accept booking|Accept replacement booking)$/, "accept");
        const why = !ok2xx(res) && res.status >= 400 ? await acceptRefusal(t, res, sitter) : null;
        if (why) { t.outcome = { blocked: true, note: why }; break; }
      } else if (status === "assigned") {
        if (!row.carePlan && !carePlanTried) { carePlanTried = true; await submitCarePlan(t, cust); await goto(sitter, workspace); continue; }
        if (b.balance && b.balance.status !== "paid" && !balanceTried) { balanceTried = true; await guarded(t, "Pet Sitting split balance paid before check-in", async () => recordPayment(t, await payFromBookingPage(t, cust, "sitting-balance"), { journeyName: "Pet Sitting split balance paid before check-in", expected: b.balance.amount })); await goto(sitter, workspace); continue; }
        if (Date.now() >= b.end) { t.info("check-in window", false, `closed at ${b.endIso} before check-in`); t.outcome = { harness: true, note: `window closed at ${b.endIso} before check-in could run` }; break; }
        const target = row.serviceLocation && Number.isFinite(Number(row.serviceLocation.latitude)) ? { latitude: Number(row.serviceLocation.latitude), longitude: Number(row.serviceLocation.longitude) } : door;
        const here = nearby(target || HOME);
        await context.setGeolocation(here).catch(() => {});
        t.info("sitter stands at the doorstep", Boolean(target), target ? `${target.latitude},${target.longitude} (${row.serviceLocation ? "accepted service location" : door?.source}); device ${haversineMeters(here, target)} m away` : "no doorstep coordinates known");
        res = await act("check in with my location", /Check in with my location/, "check_in", here);
        if (!ok2xx(res) && res.status >= 400 && !target) { t.outcome = { harness: true, note: `harness: no doorstep coordinates known (booking_service_locations / scheduler snapshot); check-in refused ${brief(res)}` }; break; }
      } else if (status === "in_progress") {
        if (!careLogged && Date.now() < b.end) {
          careLogged = true;
          await act("log care update", /^Log care update$/, "care_event", { careEventType: "general_update", detail: { message: "Pets settled and care routine is on track" } }, true);
          await act("log meal", /^Log meal$/, "care_event", { careEventType: "meal", detail: { message: "Meal completed" } }, true);
          continue;
        }
        if (!proofDone) {
          proofDone = true;
          const link = page.getByRole("link", { name: /Proof · medication · incident/ }).first();
          if (await link.isVisible().catch(() => false)) { await link.click(); await page.waitForURL(u => String(u).includes("/sitter/proof"), { timeout: 15_000 }).catch(() => {}); }
          if (!page.url().includes("/sitter/proof")) { t.uiIssues.push("Proof · medication · incident link not usable"); await goto(sitter, `/v2/partner/sitter/proof?bookingId=${enc(b.bookingId)}`); }
          await settle(page, 1500);
          const up = await uploadProof(t, sitter, { service: "pet_sitting", scopeId: b.bookingId, purpose: "sitting_update", label: "care update photo", color: [60, 170, 110] });
          t.evidence.push(await sitter.shot("sitter-proof-upload"));
          if (up.mediaId) {
            const v = await staffVerify(t, "pet_sitting", b.bookingId, [up.mediaId]);
            if (v.verified.includes(up.mediaId)) { await page.reload({ waitUntil: "domcontentloaded" }); await settle(page, 2000); await recordVerified(t, sitter, { service: "pet_sitting", scopeId: b.bookingId, mediaRef: up.mediaRef }); t.evidence.push(await sitter.shot("sitter-proof-recorded")); }
          }
          await incidentFormCheck(t, sitter, "pet_sitting");
          await goto(sitter, workspace);
          continue;
        }
        res = await act("check out", /^Check out$/, "check_out");
      } else if (status === "completed") { t.outcome.completed = true; break; }
      else { t.info("unexpected booking state", false, status); t.outcome = { harness: true, note: `unexpected state ${status}` }; break; }
      if (res && res.status === 0 && (t.unobserved = (t.unobserved || 0) + 1) <= 2) continue;
      if (res && !ok2xx(res)) break;
    }
    await goto(sitter, workspace);
    t.evidence.push(await sitter.shot("sitter-final"));
    if (!t.outcome.completed && String((await read())?.status) === "completed") t.outcome.completed = true;
    recordLifecycle(t);
    if (!t.outcome.completed) return;
    await guarded(t, "Pet Sitting D1 books after the partner lifecycle", () => readBackBooks(t, { pollMs: 30_000 }));
    await guarded(t, "Pet Sitting partner earnings after completion", () => partnerEarnings(t, sitter));
    await guarded(t, "Pet Sitting customer sees the completed booking", () => customerCompletedView(t, cust));
  } finally {
    await closeFlow(sitter, `Sitter ${b.providerId} ${b.bookingId}`);
    await cust.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Boarding
// ---------------------------------------------------------------------------------------------------------------
async function runBoarding(b, t) {
  const host = await newFlow(await getBrowser(), `70-boarding-${short(b.bookingId)}-host`, { mobile: true, geolocation: nearby(b.doorstep || HOME) });
  host.page.on("dialog", dialog => (dialog.type() === "confirm" ? dialog.accept() : dialog.dismiss()).catch(() => {}));
  const cust = customerOf(t), stayId = b.stay.id, checkOutAt = Date.parse(b.stay.checkOutAt);
  try {
    if (!(await signInProvider(t, host))) return;
    await openFromPartnerApp(t, host, "host");
    const { page, context } = host, workspace = `/v2/partner/host?bookingId=${enc(b.bookingId)}`;
    await page.getByText(/UAT · canonical stays/).first().waitFor({ timeout: 25_000 }).catch(() => t.uiIssues.push("host workspace did not render"));
    await page.getByText(/Loading governed Boarding stays/).first().waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    t.evidence.push(await host.shot("host-workspace"));
    const read = async () => { const r = await api(context, "GET", `/api/boarding-stays?bookingId=${enc(b.bookingId)}`); return Array.isArray(r.body?.data) ? r.body.data[0] || null : null; };
    const tab = async (name) => { await page.locator("aside nav button").filter({ hasText: name }).first().click({ timeout: 8000 }).catch(e => t.uiIssues.push(`${name} tab: ${oneLine(e.message, 80)}`)); await settle(page, 900); };
    /** The Today tab acts on ONE stay (the in-progress one, else the earliest accepted one): is it ours? */
    const todayIsOurs = async () => {
      await tab("Today");
      const ours = await page.getByText(new RegExp(`STAY · ${escRe(b.bookingId)}`)).first().isVisible().catch(() => false);
      if (!ours && !t.todayMismatch) {
        t.todayMismatch = true;
        const other = oneLine(await page.getByText(/(LIVE|ACCEPTED) STAY · /).first().innerText().catch(() => "NO ACTIVE STAY"), 80);
        const shot = await host.shot("host-today-shows-another-stay");
        t.uiIssues.push(`Today tab shows "${other}" instead of ${b.bookingId}`);
        fnd({ severity: "P2", area: "Boarding host workspace", persona: "Host", flow: "Host Today tab", title: "Host Today tab can act on only one stay, so a host with another accepted stay cannot check in / log care for this one", steps: `As ${b.providerId}: /v2/partner/host?bookingId=${b.bookingId} → Today`, expected: `check-in / meal / play / check-out controls for ${b.bookingId} (due now)`, actual: `Today shows "${other}" (app/host/page.tsx liveStay = the in-progress stay, else the earliest accepted one); the due stay has no controls there`, evidence: [shot] });
      }
      return ours;
    };
    const act = (step, locator, action, extra = {}, why) => press(t, host, { step, locator, why, path: "/api/boarding-stays", match: x => x.includes(`"action":"${action}"`) && (!extra.careEventType || x.includes(extra.careEventType)), fallback: async () => api(context, "POST", "/api/boarding-stays", { stayId, action, idempotencyKey: key(b, `${action}${extra.careEventType ? `-${extra.careEventType}-${istDate(Date.now())}` : ""}`), ...extra }) });
    const eventDay = (e) => istDate(Number(e.createdAt ?? e.created_at));
    const has = (stay, type, day) => (stay.events || []).some(e => String(e.eventType ?? e.event_type) === type && eventDay(e) === day);
    let carePlanTried = false, balanceTried = false, proofTried = false;
    const tried = new Set();
    for (let guard = 0; guard < 18; guard++) {
      const stay = await read();
      if (!stay) { t.info("read stay", false, "GET /api/boarding-stays returned no stay for the host"); t.outcome = { harness: true, note: "host could not read the stay" }; break; }
      const status = String(stay.status), carePlan = String(stay.carePlanStatus ?? stay.care_plan_status ?? "");
      let res = null;
      if (["awaiting_host_acceptance", "recovery_pending"].includes(status)) {
        await tab("Requests");
        const card = page.locator("button").filter({ hasText: b.bookingId }).first();
        if (await card.isVisible().catch(() => false)) await card.click().catch(() => {}); else t.uiIssues.push("stay request card not listed under Requests");
        await settle(page, 600);
        t.evidence.push(await host.shot("host-request"));
        res = await act("accept & lock capacity", page.getByRole("button", { name: /Accept (replacement )?& lock capacity/ }).first(), "accept");
        const why = !ok2xx(res) && res.status >= 400 ? await acceptRefusal(t, res, host) : null;
        if (why) { t.outcome = { blocked: true, note: why }; break; }
      } else if (status === "confirmed") {
        if (carePlan !== "ready" && !carePlanTried) { carePlanTried = true; await submitCarePlan(t, cust, stayId); await goto(host, workspace); continue; }
        if (b.balance && b.balance.status !== "paid" && !balanceTried) { balanceTried = true; await guarded(t, "Boarding split balance paid before check-in", async () => recordPayment(t, await payFromBookingPage(t, cust, "boarding-balance"), { journeyName: "Boarding split balance paid before check-in", expected: b.balance.amount })); await goto(host, workspace); continue; }
        if (Date.now() >= checkOutAt) { t.info("check-in window", false, `stay window ended ${b.stay.checkOutAt}`); t.outcome = { harness: true, note: `stay window ended ${b.stay.checkOutAt} before check-in could run` }; break; }
        const ours = await todayIsOurs();
        res = await act("check in", ours ? page.getByRole("button", { name: /✓\s*Check in/ }).first() : null, "check_in", {}, "Today tab shows another stay");
      } else if (status === "in_progress") {
        const now = Date.now(), today = istDate(now), open = now < checkOutAt;
        if (open && !has(stay, "care_meal", today) && !tried.has(`meal-${today}`)) { tried.add(`meal-${today}`); const ours = await todayIsOurs(); await act("log meal", ours ? page.getByRole("button", { name: /Log meal/ }).first() : null, "care_event", { careEventType: "meal", detail: { source: "host_workspace" } }, "Today tab shows another stay"); continue; }
        if (open && !has(stay, "care_play", today) && !tried.has(`play-${today}`)) { tried.add(`play-${today}`); const ours = await todayIsOurs(); await act("log play", ours ? page.getByRole("button", { name: /Log play/ }).first() : null, "care_event", { careEventType: "play", detail: { source: "host_workspace" } }, "Today tab shows another stay"); continue; }
        if (open && !has(stay, "proof_daily_update", today) && !proofTried) {
          proofTried = true;
          const ours = await todayIsOurs(), link = page.getByRole("link", { name: /Proof · medication · incident/ }).first();
          if (ours && await link.isVisible().catch(() => false)) { await link.click(); await page.waitForURL(u => String(u).includes("/host/proof"), { timeout: 15_000 }).catch(() => {}); }
          if (!page.url().includes("/host/proof")) { if (ours) t.uiIssues.push("Proof · medication · incident link not usable"); await goto(host, `/v2/partner/host/proof?stayId=${enc(stayId)}`); }
          await settle(page, 1500);
          const up = await uploadProof(t, host, { service: "boarding", scopeId: stayId, purpose: "stay_update", label: "daily stay photo", color: [230, 170, 40] });
          t.evidence.push(await host.shot("host-proof-upload"));
          if (up.mediaId) {
            const v = await staffVerify(t, "boarding", stayId, [up.mediaId]);
            if (v.verified.includes(up.mediaId)) { await page.reload({ waitUntil: "domcontentloaded" }); await settle(page, 2000); await recordVerified(t, host, { service: "boarding", scopeId: stayId, mediaRef: up.mediaRef }); t.evidence.push(await host.shot("host-proof-recorded")); }
          }
          await incidentFormCheck(t, host, "boarding");
          await goto(host, workspace);
          continue;
        }
        const missing = b.stay.days.flatMap(day => [["care_meal", "meal"], ["care_play", "play"], ["proof_daily_update", "verified photo"]].filter(([type]) => !has(stay, type, day)).map(([, what]) => `${day} ${what}`));
        if (missing.length) {
          const later = b.stay.days.some(day => day > today);
          t.info("check-out", false, `milestones still missing: ${missing.join(", ")}`);
          t.outcome = later ? { continues: true, note: `multi-day stay continues - check-out after the remaining days' milestones (${missing.join(", ")}); a later run continues it` } : { note: `cannot check out: milestones missing ${missing.join(", ")}` };
          if (!later && !open) fnd({ severity: "P2", area: "Boarding host workspace", persona: "Host", flow: "Check-out after the stay window", title: "A Boarding stay whose window ended with a missing milestone can never be checked out by the host", steps: `${b.bookingId}: window ended ${b.stay.checkOutAt}; milestones can no longer be recorded after check_out_at`, expected: "the host can still close the stay (or Operations is prompted)", actual: `missing ${missing.join(", ")}`, evidence: t.evidence.slice(-1) });
          break;
        }
        const ours = await todayIsOurs();
        t.evidence.push(await host.shot("host-before-check-out"));
        res = await act("check out", ours ? page.getByRole("button", { name: /✓\s*Check out/ }).first() : null, "check_out", {}, "Today tab shows another stay");
      } else if (status === "completed") { t.outcome.completed = true; break; }
      else { t.info("unexpected stay state", false, status); t.outcome = { harness: true, note: `unexpected stay state ${status}` }; break; }
      if (res && res.status === 0 && (t.unobserved = (t.unobserved || 0) + 1) <= 2) continue;
      if (res && !ok2xx(res)) break;
    }
    await goto(host, workspace);
    t.evidence.push(await host.shot("host-final"));
    if (!t.outcome.completed && String((await read())?.status) === "completed") t.outcome.completed = true;
    recordLifecycle(t);
    if (!t.outcome.completed) return;
    await guarded(t, "Boarding D1 books after the partner lifecycle", () => readBackBooks(t, { pollMs: 30_000 }));
    await guarded(t, "Boarding partner earnings after completion", () => partnerEarnings(t, host, { hostSettlementTab: true }));
    await guarded(t, "Boarding customer sees the completed booking", () => customerCompletedView(t, cust));
  } finally {
    await closeFlow(host, `Host ${b.providerId} ${b.bookingId}`);
    await cust.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery → schedule rows → lifecycles.
// ---------------------------------------------------------------------------------------------------------------
async function discover(now) {
  const present = await d1(tablesSql());
  if (present?.skipped) return { skipped: present.skipped };
  if (!Array.isArray(present)) return { error: present };
  const tables = new Set(present.map(row => String(row.name)));
  const missing = ["canonical_bookings", "canonical_customers"].filter(name => !tables.has(name));
  if (missing.length) return { error: { detail: `tables missing: ${missing.join(", ")}` } };
  const params = discoveryParams(now);
  params[0] = `${NAME_PREFIX}%`;
  const rows = await d1(discoverySql(tables), params);
  if (!Array.isArray(rows)) return { error: rows };
  return { tables: [...tables], bookings: rows.map(row => classifyBooking(row, now)) };
}
const publicView = (b) => ({ ...scheduleEntry(b), service: b.service, phase: b.phase, customerId: b.customerId, total: b.total, payment: `${b.paymentMode}/${b.paymentStatus}`, offer: b.offer });

/** Run one discovered, due booking through its partner lifecycle (also used by a local harness against a mirror). */
export async function runDueBooking(b) {
  const t = tracker(b);
  console.log(`\n--- ${LABEL[b.service]} ${b.bookingId} (${b.providerId}): ${b.reason}${b.notes.length ? ` | ${b.notes.join("; ")}` : ""}`);
  try {
    if (b.service === "pet_taxi") await runTaxi(b, t); else if (b.service === "pet_sitting") await runSitting(b, t); else await runBoarding(b, t);
  } catch (error) {
    t.outcome = { ...t.outcome, harness: true, note: `harness: ${oneLine(error?.message || error, 300)}` };
  }
  const result = recordLifecycle(t);
  out.lifecycles.push({ bookingId: b.bookingId, service: b.service, provider: b.providerId, result, outcome: t.outcome, steps: t.steps, uiIssues: t.uiIssues });
  return { result, t };
}
export async function closeShared() {
  out.staff = { signedIn: staffWho, refusals: staffRefusals };
  out.finishedAt = new Date().toISOString();
  writeJson("partner-due-lifecycle.json", out);
  if (staffFlow) { await closeFlow(staffFlow, "Staff Booking Command Center proof verification"); staffFlow = null; }
  if (browser) { await browser.close(); browser = null; }
}

async function main() {
  try {
  const now = Date.now();
  const disc = await discover(now);
  if (disc.skipped || disc.error) {
    out.discovery = disc;
    for (const service of SERVICES) rec({
      journey: `${LABEL[service]} partner lifecycle — due-booking discovery`, combo: "staging D1 (read-only)",
      result: disc.skipped ? "SKIPPED" : "BLOCKED",
      detail: `${disc.skipped ? `not checked: ${disc.skipped} in this runner, so due near-term master bookings cannot be discovered (d1() {skipped} is neither a pass nor a failure)` : `harness: staging D1 discovery failed ${oneLine(JSON.stringify(disc.error), 300)}`}. Window: ${WINDOW_RULES[service]}`,
    });
  } else {
    out.discovery = { at: new Date(now).toISOString(), namePrefix: NAME_PREFIX, tables: disc.tables.length, bookings: disc.bookings.map(publicView) };
    for (const service of SERVICES) {
      const list = disc.bookings.filter(b => b.service === service);
      const due = list.filter(b => b.phase === "due"), upcoming = list.filter(b => b.phase === "upcoming").sort((x, y) => x.actionableAt - y.actionableAt);
      const other = list.filter(b => !["due", "upcoming"].includes(b.phase));
      if (due.length && !upcoming.length && !other.length) continue;
      rec({
        journey: `${LABEL[service]} partner lifecycle — not yet due`,
        combo: upcoming.length ? `${upcoming.length} upcoming; next actionable ${upcoming[0].actionableAtUtc}` : due.length ? `${due.length} due now (below); none upcoming` : "no near-term master booking due or upcoming",
        result: "SKIPPED",
        detail: JSON.stringify({ dueNow: due.map(b => b.bookingId), upcoming: upcoming.map(scheduleEntry), notActionable: other.map(b => ({ bookingId: b.bookingId, phase: b.phase, reason: b.reason, start: b.startIso })), window: WINDOW_RULES[service] }).slice(0, 3500),
      });
    }
    const due = disc.bookings.filter(b => b.phase === "due").sort(byUrgency);
    console.log(`Discovered ${disc.bookings.length} near-term master bookings; due now: ${due.map(b => `${b.service}:${b.bookingId}`).join(", ") || "none"}`);
    if (due.length && !hasAccessCode()) {
      for (const b of due) rec({ journey: `${LABEL[b.service]} partner lifecycle as provider`, combo: combo(b), result: "BLOCKED", detail: `harness: no UAT access code in this runner - due booking not actioned (${b.reason}; ${b.notes.join("; ")})` });
    } else {
      const taken = { boarding: 0, pet_sitting: 0, pet_taxi: 0 };
      for (const b of due) {
        if (taken[b.service] >= MAX_PER_SERVICE || Date.now() - STARTED > BUDGET_MS) {
          rec({ journey: `${LABEL[b.service]} partner lifecycle as provider`, combo: combo(b), result: "SKIPPED", detail: `due (${b.reason}) but deferred: ${taken[b.service] >= MAX_PER_SERVICE ? `per-run cap of ${MAX_PER_SERVICE} per service` : "suite time budget used"}` });
          continue;
        }
        taken[b.service] += 1;
        await runDueBooking(b);
      }
    }
  }

  } catch (error) {
  console.log(`suite aborted: ${oneLine(error?.message || error, 400)}`);
  rec({ journey: "Partner-due lifecycle suite", combo: "harness", result: "BLOCKED", detail: `harness: ${oneLine(error?.stack || error, 600)}` });
  } finally {
    await closeShared();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
