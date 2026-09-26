// Preflight: prove the runner can reach staging, Razorpay and Google through the app, and read staging D1.
import { BASE, launch, staffSession, customerSession, d1, writeJson, hasAccessCode, redact, deployedSha } from "./lib.mjs";

const report = { base: BASE, at: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${redact(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`); };

const deployed = await deployedSha();
report.deployed = deployed;
check("Deployed staging commit identified", Boolean(deployed.sha), JSON.stringify(deployed));
check("UAT access code present", hasAccessCode(), hasAccessCode() ? "length >= 32" : "PAWSPACE_UAT_ACCESS_CODE missing/short");
check("Cloudflare D1 read credentials present", Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.STAGING_D1_ID), "token/account/db id");

const rzpApi = await fetch("https://api.razorpay.com/v1/payments", { signal: AbortSignal.timeout(15000) }).then(r => r.status).catch(e => String(e));
check("Razorpay API reachable from runner", rzpApi === 401, `GET /v1/payments without auth → ${rzpApi} (401 expected)`);
const rzpJs = await fetch("https://checkout.razorpay.com/v1/checkout.js", { signal: AbortSignal.timeout(15000) }).then(r => r.status).catch(e => String(e));
check("Razorpay checkout.js reachable", rzpJs === 200, `→ ${rzpJs}`);

const browser = await launch();
try {
  const staff = await browser.newContext();
  const home = await staff.request.get(BASE + "/v2");
  check("Staging /v2 answers", home.status() === 200, `HTTP ${home.status()}`);
  await staffSession(staff, "founder@pawspace.in");
  check("Founder UAT session", true, "session issued");
  const readiness = await staff.request.get(BASE + "/api/integration-readiness");
  const rb = await readiness.json().catch(() => null);
  const modules = (rb?.data?.modules || rb?.data || rb?.modules || []);
  const summary = Array.isArray(modules) ? modules.map(m => `${m.code}:${m.configuredForExternalTest ?? m.status}`).join(", ") : JSON.stringify(rb).slice(0, 600);
  check("Integration readiness readable", readiness.status() === 200, summary);

  const cust = await browser.newContext();
  const who = await customerSession(cust, "customer-a");
  check("Test customer A session (no OTP)", Boolean(who?.customerId), who?.customerId || "none");
  const q = encodeURIComponent("100 Feet Road Indiranagar Bengaluru");
  const search = await cust.request.get(`${BASE}/api/address-autocomplete?mode=search&query=${q}&sessionToken=master-preflight-1`);
  const sb = await search.json().catch(() => null);
  const suggestions = sb?.data?.suggestions || sb?.data?.predictions || [];
  check("Google Places autocomplete via staging (Maps key accepted)", search.status() === 200 && sb?.data?.status === "configured" && suggestions.length > 0, `HTTP ${search.status()} status=${sb?.data?.status} suggestions=${suggestions.length} ${sb?.data?.error || sb?.error || ""}`);
  const first = suggestions[0];
  if (first?.placeId) {
    const resolve = await cust.request.get(`${BASE}/api/address-autocomplete?mode=resolve&placeId=${encodeURIComponent(first.placeId)}&sessionToken=master-preflight-1`);
    const rb2 = await resolve.json().catch(() => null);
    check("Google Place details resolve to coordinates", resolve.status() === 200 && rb2?.data?.status === "configured" && Number.isFinite(Number(rb2?.data?.latitude)), `HTTP ${resolve.status()} ${JSON.stringify(rb2?.data || rb2).slice(0, 300)}`);
  }
  const rev = await cust.request.get(`${BASE}/api/address-autocomplete?mode=reverse&latitude=12.9719&longitude=77.6412`);
  const rvb = await rev.json().catch(() => null);
  check("Google reverse geocode via staging", rev.status() === 200 && rvb?.data?.status === "configured", `HTTP ${rev.status()} ${JSON.stringify(rvb?.data || rvb).slice(0, 300)}`);
} catch (e) {
  check("Preflight browser section", false, String(e).slice(0, 500));
} finally { await browser.close(); }

// Staging D1 evidence (read-only) for the webhook inbox. Without Cloudflare credentials (a local run) d1() returns
// {skipped}, which is reported but does not fail preflight; a query error or an empty required result does.
const d1Check = (name, rows, needRows = false) => check(name, Boolean(rows?.skipped) || (Array.isArray(rows) && (!needRows || rows.length > 0)), JSON.stringify(rows));
d1Check("D1: gateway_webhook_events triggers", await d1("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='gateway_webhook_events'"), true);
d1Check("D1: webhook inbox by status", await d1("SELECT processing_status, COUNT(*) AS n, MAX(received_at) AS last FROM gateway_webhook_events GROUP BY processing_status"));
d1Check("D1: latest webhook events", await d1("SELECT event_type, processing_status, failure_reason, received_at FROM gateway_webhook_events ORDER BY received_at DESC LIMIT 15"));
d1Check("D1: payment gateway events by authority", await d1("SELECT event_type, processing_status, json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority') AS authority, COUNT(*) AS n FROM payment_gateway_events GROUP BY 1,2,3 ORDER BY n DESC LIMIT 20"));

writeJson("preflight.json", report);
const failed = report.checks.filter(c => !c.ok).length;
console.log(`\nPreflight: ${report.checks.length - failed}/${report.checks.length} passed`);
// A failed preflight fails the run (the runner counts a non-zero exit), so a broken staging is never reported green.
process.exitCode = failed ? 1 : 0;
