// Production-readiness enforcement — a HARD, fail-closed configuration gate.
//
// THE ACCIDENT THIS PREVENTS, in one sentence: a production deploy that quietly runs on a sandbox,
// simulator, mock, or dev-fallback driver because a variable was forgotten and a default filled it in.
// `lib/razorpay-client.ts` resolves an UNSET `PAWSPACE_PAYMENT_ENV` to "sandbox"; `lib/voice-telephony-
// provider.ts` can select `local_simulator_non_production`; `lib/development-preview.ts` grants a
// permission-["*"] superuser when preview vars are on; `lib/otp-sandbox-runtime.ts` carries a hardcoded
// development assertion secret. Each is individually fail-closed, but "the driver silently defaulted"
// is the recurring shape, and nothing asserted the WHOLE surface at once, before a build shipped.
//
// This module is that single assertion. Given the deployment environment (either `process.env` at build
// time, or the Cloudflare Worker `env` at runtime), it decides whether the profile is production and,
// if so, refuses — with an explicit, unrecoverable error naming every violation — when any critical
// subsystem would run on a non-live driver, is missing a required live binding, carries a forbidden
// UAT/preview flag, or holds a fallback/placeholder secret.
//
// DESIGN RULES:
//   - Pure and side-effect-free. No I/O, no imports that execute code, no `.ts` imports (the CLI wrapper
//     runs on plain `node`, without --experimental-strip-types). Every required identifier is declared
//     here, so this module is the gate's single source of truth for what "production" requires.
//   - Enforcement only bites in a production profile. Outside it, the assertion is a no-op pass, so unit
//     tests, dev, and non-prod CI runs are never affected by ambient env.
//   - EXPLICIT sandbox is allowed (an audited pilot may choose it); a DEFAULTED sandbox is refused. The
//     accident is the unset variable, not the deliberate choice — so the gate demands the choice be made.
//   - Every fatal check names the exact variable and the exact remedy, because a gate that fails without
//     saying what to set is a gate someone disables.
//
// Severity model:
//   - "critical": an active mock/simulator/preview/fallback in production, or a live<->sandbox credential
//     collision. Throws.
//   - "required": a required live binding for an in-scope subsystem is missing. Throws.
//   - "warning":  advisory; surfaced in the report but never fatal.

/** Env keys, in precedence-agnostic OR, any of which marks a production profile. `PAWSPACE_DEPLOYMENT_ENV`
 *  is the codebase's own marker (scripts/prod-config.mjs stamps it, lib/development-preview.ts reads it);
 *  NODE_ENV and DEPLOYMENT_PROFILE are honoured so the gate answers to the conventional names too. */
export const PRODUCTION_PROFILE_KEYS = ["PAWSPACE_DEPLOYMENT_ENV", "NODE_ENV", "DEPLOYMENT_PROFILE"];

/** Vars that grant preview authority, shared-code sign-in, or UAT delivery behaviour and must never be
 *  written into a production deployment. Kept identical to scripts/prod-config.mjs, which imports THIS
 *  list, so the deploy-time var check and the runtime/secret check can never drift apart. */
export const FORBIDDEN_IN_PRODUCTION = [
  "PAWSPACE_LOCAL_PREVIEW",
  "PAWSPACE_UAT_LOGIN",
  "PAWSPACE_SCHEDULING_ENV",
  "META_WHATSAPP_UAT_DELIVERY_ENABLED",
  "PAWSPACE_MEDIA_ENV",
];

/** UAT/dev-only SECRETS and simulator toggles that make sense on a laptop or in UAT and are an active
 *  hazard in production. These are not in FORBIDDEN_IN_PRODUCTION because that list is scoped to wrangler
 *  VARS; these are runtime secrets/toggles that must be absent from the deployed environment. */
export const DEV_AND_UAT_ONLY_ENV = [
  "PAWSPACE_UAT_SIGNING_KEY",               // UAT shared-login signing key (lib/uat-staging-auth.ts)
  "PAWSPACE_UAT_ACCESS_CODE",               // UAT shared access code
  "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT", // UAT identity-assertion secret; the dev-fallback path substitutes for it
  "META_WHATSAPP_UAT_ACCESS_TOKEN",         // UAT Meta WhatsApp bearer token
  "PAWSPACE_VOICE_SIMULATOR_SECRET",        // simulator-only voice secret (lib/voice-telephony-provider.ts)
  "PAWSPACE_PAYMENT_CONTRACT_TEST",         // sandbox contract-test override flag (lib/razorpay-client.ts)
];

/** Razorpay's live order/refund credentials (sandbox counterparts carry a _SANDBOX suffix). */
export const RAZORPAY_LIVE_SECRET_NAMES = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET_LIVE"];
/** IDfy KYC — no live/sandbox split in code; presence of all four is what makes verification possible. */
export const IDFY_SECRET_NAMES = ["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_URL", "IDFY_WEBHOOK_SECRET"];
/** Exotel telephony — all six are required by lib/voice-call-gate.ts VOICE_TELEPHONY_SECRET_NAMES. */
export const EXOTEL_LIVE_SECRET_NAMES = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET"];

/** The one hardcoded dev secret in runtime code (lib/otp-sandbox-runtime.ts). If this exact value reaches
 *  a production environment, an identity-assertion secret is a known constant — a full compromise. */
const HARDCODED_DEV_ASSERTION_SECRET = "pawspace-local-development-otp-assertion-secret-v1";

/** The Razorpay simulator selection literal and the voice simulator transport literal — an ACTIVE mock
 *  driver if either is selected in production. */
const VOICE_LOCAL_SIMULATOR_TRANSPORT = "local_simulator_non_production";

/** Placeholder / fallback shapes a real production secret must never match. Catches .dev.vars leakage
 *  (uat_local_dev_*), the hardcoded dev assertion secret, and the usual "changeme"/"test-secret" family. */
const PLACEHOLDER_SECRET_PATTERNS = [
  /^uat_local_dev_/i,
  /local[-_]development/i,
  /^change[-_]?me/i,
  /^test[-_]?secret/i,
  /placeholder/i,
  /^dummy/i,
  /^example/i,
  /^sk_test_/i,
];

function str(value) {
  return value == null ? "" : String(value).trim();
}
function present(env, name) {
  return str(env?.[name]).length > 0;
}
function isBindingObject(value) {
  return Boolean(value) && typeof value === "object" && typeof value.head === "function";
}
function looksLikePlaceholder(value) {
  const v = str(value);
  if (!v) return false;
  if (v === HARDCODED_DEV_ASSERTION_SECRET) return true;
  return PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(v));
}
function isHttpsNonLoopback(raw) {
  let url;
  try {
    url = new URL(str(raw));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

/** Decide whether the supplied environment is a production profile, and report which signal said so. */
export function detectProductionProfile(env) {
  const deploymentEnv = str(env?.PAWSPACE_DEPLOYMENT_ENV).toLowerCase();
  const nodeEnv = str(env?.NODE_ENV).toLowerCase();
  const deploymentProfile = str(env?.DEPLOYMENT_PROFILE).toLowerCase();
  const signals = [];
  if (deploymentEnv === "production") signals.push("PAWSPACE_DEPLOYMENT_ENV=production");
  if (nodeEnv === "production") signals.push("NODE_ENV=production");
  if (deploymentProfile === "production") signals.push("DEPLOYMENT_PROFILE=production");
  return {
    isProduction: signals.length > 0,
    signals,
    deploymentEnv: deploymentEnv || null,
    nodeEnv: nodeEnv || null,
  };
}

// Each evaluator receives (env, push) and records checks. `push` normalises a check row.
function evaluateForbiddenAndBypass(env, push) {
  for (const name of FORBIDDEN_IN_PRODUCTION) {
    push("rbac", `forbidden_var:${name}`, "critical", !present(env, name),
      present(env, name)
        ? `${name} is present. It grants preview authority, shared-code sign-in, or UAT delivery and must never be deployed to production. Remove it.`
        : `${name} is absent.`);
  }
  for (const name of DEV_AND_UAT_ONLY_ENV) {
    push("rbac", `dev_only_secret:${name}`, "critical", !present(env, name),
      present(env, name)
        ? `${name} is a UAT/dev-only secret or toggle and must not exist in a production environment. Remove it.`
        : `${name} is absent.`);
  }

  // Live identity mode is belt-and-braces for disabling the OTP sandbox and the hardcoded dev assertion
  // secret — but both are ALREADY gated off in production independently (they need localhost + local
  // preview + a dev/test NODE_ENV, none of which exist here). So this is a defense-in-depth WARNING, not a
  // hard block: forcing it fatal could disturb live identity-secret plumbing outside this gate's remit.
  const identityEnv = str(env?.PAWSPACE_IDENTITY_ENV).toLowerCase();
  push("rbac", "identity_env_live", "warning", identityEnv === "live",
    identityEnv === "live"
      ? "PAWSPACE_IDENTITY_ENV=live."
      : `PAWSPACE_IDENTITY_ENV is "${identityEnv || "<unset>"}", not "live". Recommended so the OTP sandbox and the development assertion-secret fallback are off by declaration as well as by host gating.`);

  // A dev/test NODE_ENV in a production profile is the classic mistake: it re-opens dev-preview gating.
  const nodeEnv = str(env?.NODE_ENV).toLowerCase();
  const badNodeEnv = nodeEnv === "development" || nodeEnv === "test";
  push("rbac", "node_env_not_dev", "critical", !badNodeEnv,
    badNodeEnv
      ? `NODE_ENV is "${nodeEnv}" in a production deployment. This re-enables development-preview authentication. Set NODE_ENV=production or leave it unset.`
      : `NODE_ENV is "${nodeEnv || "<unset>"}".`);

  // Backend header-trust auth (separate service) — advisory here; the backend hard-throws on its own.
  if (present(env, "AUTH_MODE")) {
    const ok = str(env?.AUTH_MODE).toLowerCase() === "token";
    push("rbac", "backend_auth_mode_token", "warning", ok,
      ok ? "AUTH_MODE=token." : `AUTH_MODE is "${str(env?.AUTH_MODE)}", not "token"; the backend trusts x-role/x-user-id headers unless it is token. Set AUTH_MODE=token.`);
  }
}

function evaluatePayments(env, push) {
  const raw = str(env?.PAWSPACE_PAYMENT_ENV).toLowerCase();

  if (!raw) {
    // The headline accident: unset resolves to "sandbox" in lib/razorpay-client.ts. Refuse the default.
    push("payments", "payment_env_explicit", "critical", false,
      "PAWSPACE_PAYMENT_ENV is unset. It silently resolves to sandbox (no real charges) in production. Declare it explicitly as live or sandbox.");
    return;
  }
  if (raw !== "live" && raw !== "sandbox") {
    push("payments", "payment_env_valid", "critical", false,
      `PAWSPACE_PAYMENT_ENV is "${raw}", not one of: live, sandbox.`);
    return;
  }
  push("payments", "payment_env_explicit", "critical", true, `PAWSPACE_PAYMENT_ENV=${raw} (explicit).`);

  if (raw === "sandbox") {
    // A warning-severity check registers as an ACTIVE flag when ok=false; this branch is only reached when
    // sandbox is the declared mode, so the advisory is always live here.
    push("payments", "payment_sandbox_declared", "warning", false,
      "Production is running EXPLICIT sandbox payments — no customer card is charged. Intended only for a payments-off pilot.");
    return;
  }

  // live mode: every live credential and the double-gate approval must be present, live-shaped, and
  // distinct from the sandbox material.
  for (const name of RAZORPAY_LIVE_SECRET_NAMES) {
    push("payments", `razorpay_live:${name}`, "required", present(env, name),
      present(env, name) ? `${name} is set.` : `${name} is required for live payments and is missing.`);
  }
  push("payments", "razorpay_live_approved", "required",
    str(env?.PAWSPACE_PAYMENT_LIVE_APPROVED).toLowerCase() === "true",
    str(env?.PAWSPACE_PAYMENT_LIVE_APPROVED).toLowerCase() === "true"
      ? "PAWSPACE_PAYMENT_LIVE_APPROVED=true."
      : 'Live payments are not approved. Set PAWSPACE_PAYMENT_LIVE_APPROVED="true" (the deliberate live double-gate).');

  const keyId = str(env?.RAZORPAY_KEY_ID);
  if (keyId) {
    const liveShaped = keyId.startsWith("rzp_live_");
    const testShaped = keyId.startsWith("rzp_test_");
    push("payments", "razorpay_key_live_shaped", "critical", liveShaped && !testShaped,
      testShaped
        ? "RAZORPAY_KEY_ID is a rzp_test_ sandbox key placed in the live key slot — a test gateway in production."
        : liveShaped ? "RAZORPAY_KEY_ID is a live key." : `RAZORPAY_KEY_ID does not look like a live key (expected rzp_live_ prefix).`);
  }

  // A live secret equal to its sandbox counterpart means "live" is really sandbox wearing a live label.
  for (const [live, sandbox] of [["RAZORPAY_KEY_ID", "RAZORPAY_KEY_ID_SANDBOX"], ["RAZORPAY_KEY_SECRET", "RAZORPAY_KEY_SECRET_SANDBOX"], ["RAZORPAY_WEBHOOK_SECRET_LIVE", "RAZORPAY_WEBHOOK_SECRET_SANDBOX"]]) {
    if (present(env, live) && present(env, sandbox) && str(env?.[live]) === str(env?.[sandbox])) {
      push("payments", `razorpay_live_not_sandbox:${live}`, "critical", false,
        `${live} is identical to ${sandbox}. Live must not reuse the sandbox credential.`);
    }
  }
  for (const name of RAZORPAY_LIVE_SECRET_NAMES) {
    if (present(env, name) && looksLikePlaceholder(env?.[name])) {
      push("payments", `razorpay_no_placeholder:${name}`, "critical", false,
        `${name} looks like a placeholder/dev value, not a real live secret.`);
    }
  }
}

function evaluateIdentity(env, push) {
  for (const name of IDFY_SECRET_NAMES) {
    push("identity", `idfy:${name}`, "required", present(env, name),
      present(env, name) ? `${name} is set.` : `${name} is required for provider KYC (IDfy) and is missing.`);
  }
  if (present(env, "IDFY_URL")) {
    push("identity", "idfy_url_https", "critical", isHttpsNonLoopback(env?.IDFY_URL),
      isHttpsNonLoopback(env?.IDFY_URL) ? "IDFY_URL is an https non-loopback endpoint." : "IDFY_URL must be an https:// non-loopback endpoint.");
  }
  for (const name of ["IDFY_API_KEY", "IDFY_WEBHOOK_SECRET"]) {
    if (present(env, name) && looksLikePlaceholder(env?.[name])) {
      push("identity", `idfy_no_placeholder:${name}`, "critical", false, `${name} looks like a placeholder/dev value.`);
    }
  }
}

function evaluateStorage(env, push) {
  // Runtime supplies PAWSPACE_MEDIA_BUCKET as an R2 binding OBJECT (has head()); build/CLI supplies the
  // bucket NAME via PRODUCTION_R2_BUCKET_NAME, which scripts/prod-config.mjs turns into that binding.
  const bindingReady = isBindingObject(env?.PAWSPACE_MEDIA_BUCKET);
  const nameDeclared = present(env, "PRODUCTION_R2_BUCKET_NAME");
  push("storage", "media_bucket_bound", "required", bindingReady || nameDeclared,
    bindingReady
      ? "PAWSPACE_MEDIA_BUCKET R2 binding is present."
      : nameDeclared
        ? "PRODUCTION_R2_BUCKET_NAME is declared; the deploy will bind PAWSPACE_MEDIA_BUCKET."
        : "No private R2 media bucket is configured. Provide the PAWSPACE_MEDIA_BUCKET binding (runtime) or PRODUCTION_R2_BUCKET_NAME (deploy). There is no in-repo fallback store.");

  // A production media pipeline with no malware scanner is blocked by lib/media-scan-boundary.ts; surface
  // it rather than let uploads silently 503 in production.
  push("storage", "media_scan_provider", "warning", present(env, "PAWSPACE_MEDIA_SCAN_PROVIDER"),
    present(env, "PAWSPACE_MEDIA_SCAN_PROVIDER")
      ? "PAWSPACE_MEDIA_SCAN_PROVIDER is set."
      : "PAWSPACE_MEDIA_SCAN_PROVIDER is not set; media uploads will be blocked until a scanner is configured.");
}

function evaluateMessaging(env, push) {
  const raw = str(env?.PAWSPACE_COMMUNICATION_ENV).toLowerCase();
  if (!raw) {
    push("messaging", "communication_env_explicit", "critical", false,
      "PAWSPACE_COMMUNICATION_ENV is unset. It silently resolves to the sandbox simulator in production. Declare it explicitly as live or sandbox.");
  } else if (raw === "uat") {
    push("messaging", "communication_env_not_uat", "critical", false,
      'PAWSPACE_COMMUNICATION_ENV="uat" unlocks allow-listed EXTERNAL delivery and belongs only in UAT, never production.');
  } else if (raw !== "live" && raw !== "sandbox") {
    push("messaging", "communication_env_valid", "critical", false,
      `PAWSPACE_COMMUNICATION_ENV is "${raw}", not one of: live, sandbox.`);
  } else {
    push("messaging", "communication_env_explicit", "critical", true, `PAWSPACE_COMMUNICATION_ENV=${raw} (explicit).`);
    if (raw === "live") {
      // Active advisory (ok=false surfaces it as a warning): the mode is declared but unimplemented today.
      push("messaging", "communication_live_implemented", "warning", false,
        "Communication mode is declared live, but no live OUTBOUND send path is implemented yet (runtime unlocks external send only in uat). Verify the provider integration before relying on live messaging.");
    }
  }

  // Meta inbound webhook authentication must be all-or-nothing: a signature secret with no verify token
  // (or vice-versa) is a half-configured webhook that fails in a confusing way.
  const hasAppSecret = present(env, "META_WHATSAPP_APP_SECRET");
  const hasVerifyToken = present(env, "META_WHATSAPP_VERIFY_TOKEN");
  if (hasAppSecret || hasVerifyToken) {
    push("messaging", "meta_webhook_complete", "critical", hasAppSecret && hasVerifyToken,
      hasAppSecret && hasVerifyToken
        ? "Meta WhatsApp webhook auth is fully configured."
        : "Meta WhatsApp webhook is half-configured: META_WHATSAPP_APP_SECRET and META_WHATSAPP_VERIFY_TOKEN must both be set, or neither.");
  }

  // If a generic communication provider is wired, it must be an https non-loopback endpoint in production.
  if (present(env, "PAWSPACE_COMMUNICATION_PROVIDER_URL")) {
    push("messaging", "communication_provider_https", "critical", isHttpsNonLoopback(env?.PAWSPACE_COMMUNICATION_PROVIDER_URL),
      isHttpsNonLoopback(env?.PAWSPACE_COMMUNICATION_PROVIDER_URL)
        ? "PAWSPACE_COMMUNICATION_PROVIDER_URL is https non-loopback."
        : "PAWSPACE_COMMUNICATION_PROVIDER_URL must be an https:// non-loopback endpoint in production.");
  }
  for (const name of ["PAWSPACE_COMMUNICATION_WEBHOOK_SECRET", "PAWSPACE_COMMUNICATION_PROVIDER_TOKEN"]) {
    if (present(env, name) && looksLikePlaceholder(env?.[name])) {
      push("messaging", `communication_no_placeholder:${name}`, "critical", false, `${name} looks like a placeholder/dev value.`);
    }
  }
}

function evaluateVoice(env, push) {
  // An ACTIVE simulator transport in production is a mock driver placing "calls" that never happen.
  const transport = str(env?.PAWSPACE_VOICE_TRANSPORT).toLowerCase();
  push("voice", "voice_transport_not_simulator", "critical", transport !== VOICE_LOCAL_SIMULATOR_TRANSPORT,
    transport === VOICE_LOCAL_SIMULATOR_TRANSPORT
      ? `PAWSPACE_VOICE_TRANSPORT=${VOICE_LOCAL_SIMULATOR_TRANSPORT} selects the non-production voice simulator. Remove it in production.`
      : "PAWSPACE_VOICE_TRANSPORT is not the local simulator.");

  const voiceEnv = str(env?.PAWSPACE_VOICE_ENV).toLowerCase();
  if (voiceEnv === "uat") {
    push("voice", "voice_env_not_uat", "critical", false,
      'PAWSPACE_VOICE_ENV="uat" belongs only in UAT, never production.');
  }
  if (voiceEnv === "live") {
    for (const name of EXOTEL_LIVE_SECRET_NAMES) {
      push("voice", `exotel_live:${name}`, "required", present(env, name),
        present(env, name) ? `${name} is set.` : `${name} is required for live Exotel telephony and is missing.`);
    }
    push("voice", "voice_live_approved", "required", str(env?.PAWSPACE_VOICE_LIVE_APPROVED).toLowerCase() === "true",
      str(env?.PAWSPACE_VOICE_LIVE_APPROVED).toLowerCase() === "true"
        ? "PAWSPACE_VOICE_LIVE_APPROVED=true."
        : 'Live voice is not approved. Set PAWSPACE_VOICE_LIVE_APPROVED="true".');
    push("voice", "voice_callback_https", "required", isHttpsNonLoopback(env?.PAWSPACE_VOICE_STATUS_CALLBACK_URL),
      isHttpsNonLoopback(env?.PAWSPACE_VOICE_STATUS_CALLBACK_URL)
        ? "PAWSPACE_VOICE_STATUS_CALLBACK_URL is https non-loopback."
        : "PAWSPACE_VOICE_STATUS_CALLBACK_URL must be an https:// non-loopback endpoint for live voice.");
  }
}

const SUBSYSTEM_EVALUATORS = [evaluateForbiddenAndBypass, evaluatePayments, evaluateIdentity, evaluateStorage, evaluateMessaging, evaluateVoice];

/**
 * Evaluate the whole production-readiness surface for the supplied environment.
 * Returns a structured, non-throwing report. `enforced` is false (and `ok` true) outside a production
 * profile — the gate is a deliberate no-op anywhere but production.
 */
export function evaluateProductionReadiness(env) {
  const runtime = env && typeof env === "object" ? env : {};
  const profile = detectProductionProfile(runtime);
  const checks = [];
  const push = (subsystem, code, severity, ok, detail) => {
    checks.push({ subsystem, code, severity, ok: Boolean(ok), detail });
  };

  if (!profile.isProduction) {
    return {
      profile: "non-production",
      enforced: false,
      ok: true,
      signals: profile.signals,
      checks: [],
      violations: [],
      warnings: [],
    };
  }

  for (const evaluate of SUBSYSTEM_EVALUATORS) evaluate(runtime, push);

  const fatal = checks.filter((check) => !check.ok && (check.severity === "critical" || check.severity === "required"));
  const warnings = checks.filter((check) => !check.ok && check.severity === "warning");
  return {
    profile: "production",
    enforced: true,
    ok: fatal.length === 0,
    signals: profile.signals,
    checks,
    violations: fatal,
    warnings,
  };
}

/** The unrecoverable configuration error the gate throws. Carries the structured report for callers/CI. */
export class ProductionReadinessError extends Error {
  constructor(report) {
    const lines = report.violations.map((v) => `  - [${v.subsystem}] ${v.code}: ${v.detail}`);
    super(`Production readiness FAILED — ${report.violations.length} blocking configuration violation(s):\n${lines.join("\n")}`);
    this.name = "ProductionReadinessError";
    this.report = report;
    this.violations = report.violations;
  }
}

/**
 * Assert the environment is production-ready, or throw ProductionReadinessError naming every violation.
 * A no-op that returns the report unchanged when the profile is not production.
 */
export function assertProductionReadiness(env) {
  const report = evaluateProductionReadiness(env);
  if (!report.enforced) return report;
  if (report.violations.length > 0) throw new ProductionReadinessError(report);
  return report;
}
