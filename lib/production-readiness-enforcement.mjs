const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

const MOCK_DRIVER = /^(?:mock|memory|in[-_ ]?memory|stub|fake|noop|sandbox|uat(?:_mock)?|test|disabled|none)$/i;
const READY_HANDLER_STATES = new Set(["implemented", "production_ready"]);

export class ProductionConfigurationError extends Error {
  constructor(problems) {
    const unique = [...new Set(problems.map((problem) => clean(problem)).filter(Boolean))];
    super(`PRODUCTION_CONFIGURATION_ERROR: ${unique.join("; ")}`);
    this.name = "ProductionConfigurationError";
    this.code = "PRODUCTION_CONFIGURATION_ERROR";
    this.problems = unique;
  }
}

/**
 * This registry is intentionally conservative. A handler stays non-ready until the production path
 * actually exists; adding credentials must never convert a mock/UAT code path into production truth.
 */
export const PRODUCTION_SERVICE_REGISTRY = Object.freeze([
  Object.freeze({
    id: "idfy_provider_verification",
    driver: "idfy_http",
    requiredSecrets: Object.freeze(["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_WEBHOOK_SECRET"]),
    requiredConfig: Object.freeze(["IDFY_URL"]),
    handlers: Object.freeze([
      Object.freeze({ name: "verification_submission", state: "implemented" }),
      Object.freeze({ name: "signed_verification_callback", state: "implemented" }),
    ]),
  }),
  Object.freeze({
    id: "provider_document_storage",
    driver: "cloudflare_r2_binding",
    requiredSecrets: Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
    requiredConfig: Object.freeze(["PRODUCTION_R2_BUCKET_NAME"]),
    handlers: Object.freeze([
      // Current onboarding accepts a caller-supplied file_ref. Until server-owned byte upload exists,
      // this must block a production build even if an R2 bucket has been provisioned.
      Object.freeze({ name: "server_owned_secure_upload", state: "missing" }),
    ]),
  }),
  Object.freeze({
    id: "provider_agreement_esign",
    // The current provider route exposes accept_sla_uat. It is a UAT-only acceptance path, not e-sign.
    driver: "uat_mock",
    requiredSecrets: Object.freeze([]),
    requiredConfig: Object.freeze([]),
    handlers: Object.freeze([
      Object.freeze({ name: "verified_digital_esign", state: "mock" }),
    ]),
  }),
]);

export function deploymentProfile(env = process.env) {
  return lower(env.DEPLOYMENT_PROFILE || env.PAWSPACE_DEPLOYMENT_ENV || env.NODE_ENV);
}

export function isProductionProfile(env = process.env) {
  return deploymentProfile(env) === "production";
}

function resolveDriver(service, env) {
  if (typeof service.driver === "function") return clean(service.driver(env));
  if (service.driverEnv) return clean(env[service.driverEnv]);
  return clean(service.driver);
}

function requireNames(service, env, names, kind, problems) {
  for (const name of names || []) {
    if (!clean(env[name])) problems.push(`${service.id}: missing required production ${kind} ${name}`);
  }
}

function validateKnownValues(service, env, problems) {
  if (service.id !== "idfy_provider_verification") return;
  const raw = clean(env.IDFY_URL);
  if (!raw) return;
  try {
    const url = new URL(raw);
    const host = lower(url.hostname);
    if (url.protocol !== "https:") problems.push(`${service.id}: IDFY_URL must use https`);
    if (!host || host === "localhost" || host === "127.0.0.1" || host.endsWith(".invalid")) {
      problems.push(`${service.id}: IDFY_URL points to a non-production host`);
    }
  } catch {
    problems.push(`${service.id}: IDFY_URL is not a valid URL`);
  }
}

export function collectProductionReadinessProblems(env = process.env, registry = PRODUCTION_SERVICE_REGISTRY) {
  if (!isProductionProfile(env)) return [];
  const problems = [];

  for (const service of registry) {
    const driver = resolveDriver(service, env);
    if (!driver) problems.push(`${service.id}: production driver is not configured`);
    else if (MOCK_DRIVER.test(driver)) problems.push(`${service.id}: production driver '${driver}' is mock or sandbox-only`);

    requireNames(service, env, service.requiredSecrets, "secret", problems);
    requireNames(service, env, service.requiredConfig, "configuration", problems);
    validateKnownValues(service, env, problems);

    for (const handler of service.handlers || []) {
      const state = lower(handler.state);
      if (!READY_HANDLER_STATES.has(state)) {
        problems.push(`${service.id}: handler ${handler.name} is ${state || "unbuilt"}`);
      }
    }
  }
  return problems;
}

export function assertProductionReadiness(env = process.env, registry = PRODUCTION_SERVICE_REGISTRY) {
  const profile = deploymentProfile(env);
  if (profile !== "production") return { ok: true, enforced: false, profile: profile || "unspecified" };

  const problems = collectProductionReadinessProblems(env, registry);
  if (problems.length) throw new ProductionConfigurationError(problems);
  return { ok: true, enforced: true, profile, servicesChecked: registry.length };
}
