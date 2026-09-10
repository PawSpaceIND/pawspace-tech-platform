/** Read-only certification of an already-created isolated checkout Worker/D1. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeCheckoutVersion, readCheckoutDatabaseInventory, CHECKOUT_REPOSITORY } from "../lib/checkout-sandbox-hosting.ts";

const evidence = resolve(process.env.CHECKOUT_EVIDENCE_DIR || "checkout-existing-evidence");
mkdirSync(evidence, { recursive: true });
const sha = String(process.env.EXPECTED_SHA || "").trim();
const worker = String(process.env.EXPECTED_WORKER_NAME || "").trim();
const account = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const UAT_ACCESS_ENV = "PAWSPACE_" + "UAT_ACCESS_CODE";
const accessCode = String(process.env[UAT_ACCESS_ENV] || "");
const report = { candidateSha: sha, worker, hosted: false, customerUiVerified: false, capture: "NOT_RUN", providerWebhookDelivery: "NOT_RUN", checks: {} };
const check = (name, condition) => { report.checks[name] = Boolean(condition); if (!condition) throw new Error(`Existing sandbox check failed: ${name}`); };
if (!/^[0-9a-f]{40}$/.test(sha) || !/^pawspace-checkout-674-[0-9]+-[0-9]+$/.test(worker)) throw new Error("Exact candidate SHA and run-derived Worker name are required");
if (!/^[a-f0-9]{32}$/i.test(account) || !token || accessCode.trim() !== accessCode || accessCode.length < 32) throw new Error("Protected Cloudflare and UAT credentials are required");
const cfBase = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const cf = async (path, options = {}) => {
  const r = await fetch(cfBase + path, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.success !== true) throw new Error(`Cloudflare read refused (${path.replace(/[0-9a-f-]{32,}/gi, "[id]")}, HTTP ${r.status})`);
  return options.includePagination ? b : b.result;
};
const app = async (origin, path, options = {}) => {
  const r = await fetch(origin + path, { ...options, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text(), setCookie: r.headers.get("set-cookie") || "" };
};
const appEventually = async (origin, path, predicate, options = {}) => {
  let last = { status: 0, type: "", text: "", setCookie: "" };
  for (let attempt = 0; attempt < 10; attempt++) {
    try { last = await app(origin, path, options); if (predicate(last)) return last; } catch { /* bounded propagation retry */ }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return last;
};
try {
  const prResponse = await fetch(`https://api.github.com/repos/${CHECKOUT_REPOSITORY}/pulls/674`, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!prResponse.ok) throw new Error("Unable to revalidate PR674");
  const pr = await prResponse.json();
  check("currentPrHead", pr.state === "open" && pr.head?.sha === sha && pr.head?.ref === "fix/customer-sandbox-checkout-wiring-20260909" && pr.head?.repo?.full_name === CHECKOUT_REPOSITORY);
  const subdomain = await cf("/workers/subdomain");
  const origin = `https://${worker}.${subdomain.subdomain}.workers.dev`;
  report.origin = origin;
  const settings = await cf(`/workers/scripts/${worker}/settings`);
  const deployments = await cf(`/workers/scripts/${worker}/deployments`);
  report.activeDeployment = activeCheckoutVersion(deployments, settings, sha);
  const bindings = settings.bindings || [];
  const dbBindings = bindings.filter(binding => binding.type === "d1");
  check("singleDatabaseBinding", dbBindings.length === 1 && dbBindings[0].name === "DB");
  const inventory = await readCheckoutDatabaseInventory(page => cf(`/d1/database?per_page=100&page=${page}`, { includePagination: true }));
  const boundDb = inventory.filter(row => row.uuid === String(dbBindings[0]?.id || "").toLowerCase());
  check("isolatedDatabaseIdentity", boundDb.length === 1 && boundDb[0].name === worker);
  for (const name of ["pawspace-prod-bengaluru", "pawspace-staging", "pawspace-release-preview"]) check(`protectedDatabase:${name}`, inventory.filter(row => row.name === name).length === 1 && boundDb[0]?.uuid !== inventory.find(row => row.name === name)?.uuid);
  for (const name of ["PAWSPACE_"+"UAT_ACCESS_CODE","PAWSPACE_"+"UAT_SIGNING_KEY","PAWSPACE_"+"IDENTITY_ASSERTION_SECRET_UAT","RAZORPAY_KEY_ID_SANDBOX","RAZORPAY_KEY_SECRET_SANDBOX","RAZORPAY_WEBHOOK_SECRET_SANDBOX","GOOGLE_MAPS_SERVER_API_KEY_UAT"]) check(`secret:${name}`, bindings.some(binding => binding.name === name && binding.type === "secret_text"));
  for (const [name,value] of Object.entries({PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",PAWSPACE_LOCAL_PREVIEW:"off",PAWSPACE_VOICE_ENV:"disabled",PAWSPACE_MAPS_ENV:"sandbox",PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:"on"})) check(`binding:${name}`, bindings.some(binding => binding.name === name && binding.type === "plain_text" && binding.text === value));
  const schedules = await cf(`/workers/scripts/${worker}/schedules`);
  check("noBackgroundCron", Array.isArray(schedules.schedules) ? schedules.schedules.length === 0 : Array.isArray(schedules) && schedules.length === 0);
  const htmlReady = result => result.status === 200 && /text\/html/i.test(result.type) && /pawspace/i.test(result.text);
  const home = await appEventually(origin, "/mobile-app", htmlReady);
  check("rootDocumentReachable", htmlReady(home));
  const loginPage = await appEventually(origin, "/staging-login", result => result.status === 200 && /text\/html/i.test(result.type));
  check("uatLoginPage", loginPage.status === 200);
  const login = await app(origin, "/api/staging-login", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: "founder@pawspace.in", code: accessCode }) });
  check("uatLoginApi", login.status === 200 && Boolean(login.setCookie));
  const cookie = login.setCookie.split(";",1)[0];
  const maps = await app(origin, "/api/address-autocomplete?mode=search&query=Indiranagar%2C%20Bengaluru%20560038", { headers: { cookie } });
  let mapsBody = {}; try { mapsBody = JSON.parse(maps.text); } catch {}
  check("mapsAutocompleteConfigured", maps.status === 200 && mapsBody?.data?.status === "configured" && Array.isArray(mapsBody?.data?.suggestions) && mapsBody.data.suggestions.length > 0);
  const anonymous = await app(origin, "/api/customer-checkout", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  check("checkoutRejectsAnonymous", [401,403].includes(anonymous.status));
  const unsigned = await app(origin, "/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("canonicalWebhookRejectsUnsigned", [400,401].includes(unsigned.status));
  report.surfaceStatus = { customer: home.status, login: loginPage.status, mapsAutocomplete: maps.status, anonymousCheckout: anonymous.status, unsignedWebhook: unsigned.status };
  report.hosted = true;
} catch (error) {
  report.error = error instanceof Error ? error.message.split(accessCode).join("[REDACTED]") : "Existing sandbox verification failed";
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(evidence, "hosting-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ candidateSha: report.candidateSha, worker: report.worker, hosted: report.hosted, capture: report.capture, providerWebhookDelivery: report.providerWebhookDelivery, error: report.error || null }));
}
