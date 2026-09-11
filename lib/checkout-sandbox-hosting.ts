/** Exact-candidate hosting policy for the separate PR674 sandbox. No network or secret logging. */
type Env = Record<string, string | undefined>;
export const CHECKOUT_REPOSITORY = "PawSpaceIND/pawspace-tech-platform";
export const CHECKOUT_BRANCH = "fix/customer-sandbox-checkout-wiring-20260909";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const required = (env: Env, key: string) => {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
};
export function checkoutSandboxPlan(env: Env) {
  if (env.GITHUB_REPOSITORY !== CHECKOUT_REPOSITORY || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.CONFIRM !== "checkout-sandbox-674") {
    throw new Error("Checkout hosting requires a confirmed manual run from protected main");
  }
  const sha = required(env, "EXPECTED_SHA");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("An exact lowercase product SHA is required");
  const runId = required(env, "GITHUB_RUN_ID"), attempt = required(env, "GITHUB_RUN_ATTEMPT");
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,5}$/.test(attempt)) throw new Error("Invalid run identity");
  const worker = `pawspace-checkout-674-${runId}-${attempt}`;
  const previewId = required(env, "RELEASE_PREVIEW_D1_ID").toLowerCase();
  if (!uuid.test(previewId)) throw new Error("Invalid frozen-preview database reference");
  // Production/shared-staging UUIDs are discovered from Cloudflare, not opaque legacy secrets.
  // No resource allocation is allowed until resolveCheckoutDatabaseGuards proves the full inventory.
  const protectedIds = [previewId];
  const frozenWorker = required(env, "RELEASE_PREVIEW_WORKER_NAME");
  if (worker.toLowerCase() === frozenWorker.toLowerCase()) throw new Error("Frozen preview Worker collision");
  if (env.PAWSPACE_PAYMENT_ENV !== "sandbox" || env.FORBID_PRODUCTION !== "true" ||
      env.PAWSPACE_PAYMENT_LIVE_APPROVED !== "false") throw new Error("Sandbox payment declarations are required");
  const keyId = required(env, "RAZORPAY_KEY_ID_SANDBOX");
  if (!/^rzp_test_[a-zA-Z0-9]+$/.test(keyId) || /placeholder/i.test(keyId)) throw new Error("Only a genuine TEST-key shape is accepted");
  const names = ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT",
    "RAZORPAY_KEY_ID_SANDBOX", "RAZORPAY_KEY_SECRET_SANDBOX", "RAZORPAY_WEBHOOK_SECRET_SANDBOX", "GOOGLE_MAPS_SERVER_API_KEY_UAT"];
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = required(env, name);
    if (env[name] !== value) throw new Error(`Credential has surrounding whitespace: ${name}`);
    if (name.startsWith("PAWSPACE_") && (value.length < 32 || /^pawspace[-_]/i.test(value))) throw new Error(`Unsafe UAT credential: ${name}`);
    secrets[name] = value;
  }
  return { sha, worker, protectedIds, frozenWorker, secrets };
}
export function checkoutSandboxConfig(artifact: Record<string, unknown>, plan: ReturnType<typeof resolveCheckoutDatabaseGuards>, databaseId: string) {
  if (plan.inventoryVerified !== true) throw new Error("A complete authoritative database inventory is required");
  if (!uuid.test(databaseId) || plan.protectedIds.includes(databaseId.toLowerCase()) || plan.inventoryIds.includes(databaseId.toLowerCase())) throw new Error("New database must be isolated from all protected targets");
  const assets = artifact.assets as Record<string, unknown> | undefined;
  if (artifact.main !== "index.js" || assets?.directory !== "../client" || artifact.no_bundle !== true) throw new Error("Unexpected root vinext artifact");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(artifact.compatibility_date))) throw new Error("Invalid artifact compatibility date");
  const flags = artifact.compatibility_flags;
  if (!Array.isArray(flags) || !flags.includes("nodejs_compat")) throw new Error("Root Worker requires nodejs_compat");
  // Build an allowlist rather than spread inherited bindings, routes, crons, remote services or vars.
  return {
    name: plan.worker, main: "index.js", compatibility_date: artifact.compatibility_date,
    compatibility_flags: flags, no_bundle: true,
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    assets: { directory: "../client" }, workers_dev: true, preview_urls: false,
    routes: [], triggers: { crons: [] },
    d1_databases: [{ binding: "DB", database_name: plan.worker, database_id: databaseId }],
    vars: {
      NODE_ENV: "production", APP_ENV: "staging", PAWSPACE_DEPLOYMENT_ENV: "checkout-sandbox",
      PAWSPACE_ENVIRONMENT: "checkout-sandbox", PAWSPACE_RELEASE_SHA: plan.sha,
      PAWSPACE_LOCAL_PREVIEW: "off", PAWSPACE_UAT_LOGIN: "on",
      PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
      PAWSPACE_COMMUNICATION_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox", PAWSPACE_VOICE_ENV: "disabled",
      PAWSPACE_VOICE_UAT_APPROVED: "false", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_MEDIA_ENV: "uat",
      PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on",
      ...Object.fromEntries(["PAYMENTS", "PAYOUTS", "REFUNDS", "BANK_INSTRUCTIONS", "WHATSAPP", "SMS", "EMAIL", "PUSH",
        "TELEPHONY", "KYC", "ESIGN", "MAPS_BILLING", "EXTERNAL_AI", "ACCOUNTING", "TAX_POSTING"].map(name => [`PAWSPACE_LIVE_${name}`, "false"])),
      PAWSPACE_PROVIDER_MARKETPLACE_LIVE: "false", PAWSPACE_PROVIDER_ORDER_ELIGIBLE: "false", PAWSPACE_PROVIDER_ACTIVATION: "uat_ready",
    },
  };
}
export function assertCheckoutCandidate(pr: { head?: { sha?: string; ref?: string; repo?: { full_name?: string } }; state?: string }, sha: string) {
  if (pr.state !== "open" || pr.head?.sha !== sha || pr.head.ref !== CHECKOUT_BRANCH || pr.head.repo?.full_name !== CHECKOUT_REPOSITORY) {
    throw new Error("PR674 moved or does not identify the approved same-repository candidate");
  }
}

export function activeCheckoutVersion(deployments: { deployments?: { id?: string; versions?: { version_id?: string; percentage?: number }[] }[] }, settings: { annotations?: Record<string, string> }, sha: string) {
  const active = deployments.deployments?.[0];
  if (!active?.id || active.versions?.length !== 1 || active.versions[0].percentage !== 100 || !active.versions[0].version_id ||
      settings.annotations?.["workers/message"] !== `checkout-sandbox ${sha}`) throw new Error("Active deployment provenance is not the exact checkout candidate");
  return { deploymentId: active.id, versionId: active.versions[0].version_id };
}

export type CheckoutDatabase = { uuid: string; name: string };
type DatabasePage = { result?: unknown; result_info?: { page?: number; per_page?: number } };
/** Every page is read through an explicit empty terminal page. Missing/malformed/repeated pages fail. */
export async function readCheckoutDatabaseInventory(readPage: (page: number) => Promise<DatabasePage>): Promise<CheckoutDatabase[]> {
  const rows: CheckoutDatabase[] = [], seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const response = await readPage(page), items = response.result;
    if (!Array.isArray(items) || items.length > 100 ||
        (response.result_info?.page !== undefined && response.result_info.page !== page) ||
        (response.result_info?.per_page !== undefined && response.result_info.per_page !== 100)) {
      throw new Error("Database inventory pagination is incomplete or malformed");
    }
    if (!items.length) return rows;
    for (const item of items) {
      if (!item || typeof item.uuid !== "string" || !uuid.test(item.uuid) || typeof item.name !== "string" || !item.name.trim()) {
        throw new Error("Database inventory contains an invalid identity");
      }
      const id = item.uuid.toLowerCase();
      if (seen.has(id)) throw new Error("Database inventory repeated an identity; completion cannot be proved");
      seen.add(id); rows.push({ uuid: id, name: item.name });
    }
  }
  throw new Error("Database inventory exceeded its bounded page limit without a terminal page");
}
/** Resolve canonical protected names and cross-check the frozen Worker's actual DB binding. */
export function resolveCheckoutDatabaseGuards(plan: ReturnType<typeof checkoutSandboxPlan>, inventory: CheckoutDatabase[], frozenSettings: { bindings?: { name?: string; type?: string; id?: string }[] }) {
  const ids = inventory.map(row => row.uuid.toLowerCase());
  if (inventory.some(row => !uuid.test(row.uuid) || !row.name) || new Set(ids).size !== ids.length) throw new Error("Invalid authoritative database inventory");
  const protectedIds = [...plan.protectedIds];
  for (const name of ["pawspace-prod-bengaluru", "pawspace-staging"]) {
    const matches = inventory.filter(row => row.name === name);
    if (matches.length !== 1) throw new Error(`Cannot unambiguously resolve protected database: ${name}`);
    protectedIds.push(matches[0].uuid.toLowerCase());
  }
  const preview = inventory.filter(row => row.uuid.toLowerCase() === plan.protectedIds[0]);
  const frozen = (frozenSettings.bindings || []).filter(binding => binding.type === "d1");
  if (preview.length !== 1 || preview[0].name !== plan.frozenWorker || frozen.length !== 1 ||
      frozen[0].name !== "DB" || String(frozen[0].id).toLowerCase() !== preview[0].uuid.toLowerCase()) {
    throw new Error("Frozen preview binding does not match the authoritative database inventory");
  }
  if (new Set(protectedIds).size !== 3) throw new Error("Protected production, staging and preview databases overlap");
  if (inventory.some(row => row.name === plan.worker)) throw new Error("New checkout database name already exists");
  return { ...plan, protectedIds, inventoryIds: ids, inventoryVerified: true as const };
}
