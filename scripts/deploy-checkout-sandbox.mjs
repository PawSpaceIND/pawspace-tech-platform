/** Manual protected-main provisioning. Creates NEW resources; never accepts a destination from input. */
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkoutSandboxPlan, checkoutSandboxConfig, assertCheckoutCandidate, activeCheckoutVersion, readCheckoutDatabaseInventory, resolveCheckoutDatabaseGuards, CHECKOUT_REPOSITORY } from "../lib/checkout-sandbox-hosting.ts";

const candidate = resolve(process.env.CANDIDATE_DIR || "candidate");
const evidence = resolve(process.env.CHECKOUT_EVIDENCE_DIR || "checkout-sandbox-evidence");
mkdirSync(evidence, { recursive: true });
const report = { candidateSha: process.env.EXPECTED_SHA, hosted: false, capture: "NOT_RUN", providerWebhookDelivery: "NOT_RUN", checks: {} };
let plan = checkoutSandboxPlan(process.env); // All safety/secret requirements BEFORE any network or resource creation.
const account = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
if (!/^[a-f0-9]{32}$/i.test(account) || !token) throw new Error("Cloudflare account authentication is required");
const privateDir = mkdtempSync(resolve(tmpdir(), "pawspace-checkout-private-"));
const secretsFile = resolve(privateDir, "secrets.json");
const cfBase = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const cf = async (path, options = {}) => {
  const r = await fetch(cfBase + path, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const b = await r.json().catch(() => ({}));
  if (options.allow404 && r.status === 404) return null;
  if (!r.ok || b.success !== true) throw new Error(`Cloudflare request refused (${options.method || "GET"} ${path.replace(/[0-9a-f-]{32,}/gi, "[id]")}, HTTP ${r.status})`);
  return options.includePagination ? b : b.result;
};
const app = async (origin, path, options = {}) => {
  const r = await fetch(origin + path, { ...options, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
};
const check = (name, condition) => { report.checks[name] = Boolean(condition); if (!condition) throw new Error(`Hosted check failed: ${name}`); };
try {
  const prResponse = await fetch(`https://api.github.com/repos/${CHECKOUT_REPOSITORY}/pulls/674`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!prResponse.ok) throw new Error("Unable to revalidate PR674 immediately before provisioning");
  assertCheckoutCandidate(await prResponse.json(), plan.sha);
  const actual = spawnSync("git", ["-C", candidate, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (actual.status !== 0 || actual.stdout.trim() !== plan.sha) throw new Error("Candidate checkout SHA mismatch");
  const dirty = spawnSync("git", ["-C", candidate, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Candidate tracked source is modified");
  const artifactPath = resolve(candidate, "dist/server/wrangler.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const inventory = await readCheckoutDatabaseInventory(page => cf(`/d1/database?per_page=100&page=${page}`, { includePagination: true }));
  const frozenSettings = await cf(`/workers/scripts/${plan.frozenWorker}/settings`);
  plan = resolveCheckoutDatabaseGuards(plan, inventory, frozenSettings);
  report.databaseIsolation = { inventoryComplete: true, existingDatabaseCount: inventory.length, protectedTargetsResolved: 3 };
  // Validate the artifact only after authoritative isolation is proved, still before any resource write.
  checkoutSandboxConfig(artifact, plan, "00000000-0000-4000-8000-000000000674");
  const frozenBefore = await cf(`/workers/scripts/${plan.frozenWorker}/deployments`);
  if (!frozenBefore.deployments?.[0]?.id) throw new Error("Cannot record frozen-preview deployment before provisioning");
  report.frozenPreviewDeployment = frozenBefore.deployments[0].id;
  const existing = await cf(`/workers/scripts/${plan.worker}/settings`, { allow404: true });
  if (existing !== null) throw new Error("Worker already exists; this create-only run will not overwrite it");
  const db = await cf("/d1/database", { method: "POST", body: JSON.stringify({ name: plan.worker }) });
  if (db.name !== plan.worker) throw new Error("Created database name mismatch");
  const config = checkoutSandboxConfig(artifact, plan, db.uuid);
  console.log(`::add-mask::${db.uuid}`);
  // This private recovery manifest is deliberately excluded from artifacts and console output.
  writeFileSync(resolve(privateDir, "created-resource.json"), JSON.stringify({ worker: plan.worker, databaseId: db.uuid, sha: plan.sha }), { mode: 0o600 });
  writeFileSync(artifactPath, JSON.stringify(config));
  writeFileSync(secretsFile, JSON.stringify(plan.secrets), { mode: 0o600 });
  report.worker = plan.worker;
  report.databaseCreated = true;
  const wrangler = resolve(candidate, "node_modules/.bin/wrangler");
  const deployed = spawnSync(wrangler, ["deploy", "--config", artifactPath, "--secrets-file", secretsFile, "--message", `checkout-sandbox ${plan.sha}`],
    { cwd: candidate, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  const raw = `${deployed.stdout || ""}\n${deployed.stderr || ""}`;
  let safeLog = raw;
  for (const value of [token, account, db.uuid, ...Object.values(plan.secrets)]) if (value) safeLog = safeLog.split(value).join("[REDACTED]");
  writeFileSync(resolve(evidence, "deploy.log"), safeLog);
  if (deployed.status !== 0) throw new Error("Wrangler deployment failed; see redacted deploy.log");
  const urls = raw.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/g) || [];
  const origin = urls.find(value => new URL(value).hostname.startsWith(`${plan.worker}.`));
  if (!origin) throw new Error("Deployment did not return the expected dedicated Worker origin");
  report.origin = origin;
  const settings = await cf(`/workers/scripts/${plan.worker}/settings`);
  const deployments = await cf(`/workers/scripts/${plan.worker}/deployments`);
  report.activeDeployment = activeCheckoutVersion(deployments, settings, plan.sha);
  const bindings = settings.bindings || [];
  check("isolatedDatabaseBinding", bindings.filter(b => b.type === "d1").length === 1 && bindings.some(b => b.name === "DB" && b.id === db.uuid));
  for (const [name, value] of Object.entries(config.vars)) check(`binding:${name}`, bindings.some(b => b.name === name && b.type === "plain_text" && b.text === value));
  for (const name of Object.keys(plan.secrets)) check(`secret:${name}`, bindings.some(b => b.name === name && b.type === "secret_text"));
  const schedules = await cf(`/workers/scripts/${plan.worker}/schedules`);
  check("noBackgroundCron", Array.isArray(schedules.schedules) ? schedules.schedules.length === 0 : Array.isArray(schedules) && schedules.length === 0);
  const home = await app(origin, "/mobile-app");
  check("rootCustomerHtml", home.status === 200 && /text\/html/i.test(home.type) && /pawspace/i.test(home.text));
  const login = await app(origin, "/staging-login");
  check("uatLoginPage", login.status === 200 && /text\/html/i.test(login.type));
  const anonymous = await app(origin, "/api/customer-checkout", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  check("checkoutRejectsAnonymous", [401, 403].includes(anonymous.status));
  const unsigned = await app(origin, "/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("canonicalWebhookRejectsUnsigned", unsigned.status === 400 || unsigned.status === 401);
  report.surfaceStatus = { customer: home.status, login: login.status, anonymousCheckout: anonymous.status, unsignedWebhook: unsigned.status };
  const frozenAfter = await cf(`/workers/scripts/${plan.frozenWorker}/deployments`);
  check("frozenPreviewUnchanged", frozenAfter.deployments?.[0]?.id === report.frozenPreviewDeployment);
  report.hosted = true;
  console.log(JSON.stringify({ worker: plan.worker, origin, candidateSha: plan.sha, hosted: true, capture: "NOT_RUN", providerWebhookDelivery: "NOT_RUN" }));
} catch (error) {
  report.error = error instanceof Error ? error.message : "Sandbox provisioning failed";
  console.error(report.error);
  process.exitCode = 1;
} finally {
  rmSync(privateDir, { recursive: true, force: true });
  writeFileSync(resolve(evidence, "hosting-report.json"), JSON.stringify(report, null, 2));
}
