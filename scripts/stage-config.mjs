// Patch the vinext/@cloudflare/vite-plugin build output (dist/server/wrangler.json) for the ISOLATED
// STAGING deploy: rename the worker to pawspace-staging, point the DB binding at the staging D1, and
// pin sandbox mode. Run AFTER `npm run build`, BEFORE `wrangler deploy` (from dist/server).
//
// SECRETS: this script configures the staging UAT sign-in, and it used to carry a committed fallback
// for each of the three credentials involved — the access code, the UAT signing key and the
// identity-assertion secret. Because .github/workflows/deploy-staging.yml passed only STAGING_D1_ID,
// those fallbacks were not merely available, they were what every CI deploy actually shipped, and all
// three were readable in a public repository. The signing key is what mints the session cookie
// resolveActor trusts, so anyone who could read the repo could forge a staging staff session.
//
// It now FAILS CLOSED. Every credential must be supplied from the environment, must clear a minimum
// strength, and must not be one of the values that were once committed (those are public forever, so
// re-supplying one is the same defect wearing a secret's clothes). Nothing secret is ever printed.
//
// Required env:
//   STAGING_D1_ID                          the id from `npx wrangler d1 create pawspace-staging`
//   PAWSPACE_UAT_ACCESS_CODE               shared code testers type at /staging-login (>=32 chars)
//   PAWSPACE_UAT_SIGNING_KEY               HMAC key for the UAT session cookie   (>=32 chars)
//   PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT signs customer/partner OTP assertions (>=32 chars)
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

/**
 * Values that were committed to this repository. They are public and permanently burned; a deploy
 * must refuse them even when they arrive through a secret, or the fix is cosmetic.
 */
export const BURNED_CREDENTIALS = [
  "pawspace-uat-2026",
  "pawspace-staging-uat-signing-key-do-not-reuse-in-prod",
  "pawspace-staging-identity-assertion-uat-secret",
];

/**
 * Read a required credential. No fallback, a minimum length, and a rejection of anything previously
 * committed. Errors name the variable and never echo the value.
 */
export function readSecret(env, name, minLength, purpose) {
  const value = String(env?.[name] || "").trim();
  if (!value) return { error: `${name} is not set. ${purpose} Provide it from a GitHub Actions secret (secrets.${name}); there is deliberately no default.` };
  if (value.length < minLength) return { error: `${name} is too short (needs at least ${minLength} characters). ${purpose}` };
  if (BURNED_CREDENTIALS.includes(value)) return { error: `${name} is one of the values that was committed to this repository and is therefore public. Generate a new one — for example: openssl rand -hex 32` };
  return { value };
}

const d1Id = String(process.env.STAGING_D1_ID || "").trim();
const problems = [];
if (!d1Id || d1Id === "00000000-0000-4000-8000-000000000000") {
  problems.push("STAGING_D1_ID is not set (from: npx wrangler d1 create pawspace-staging).");
}

const REQUIRED = [
  ["PAWSPACE_UAT_ACCESS_CODE", 32, "Testers type this at /staging-login."],
  ["PAWSPACE_UAT_SIGNING_KEY", 32, "This signs the UAT session cookie that resolveActor trusts."],
  ["PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT", 32, "This signs customer and partner OTP identity assertions."],
];
for (const [name, minLength, purpose] of REQUIRED) {
  const result = readSecret(process.env, name, minLength, purpose);
  if (result.error) problems.push(result.error);
}

if (problems.length) {
  console.error("Refusing to configure the staging deploy:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nStaging UAT sign-in grants staff access to the staging workspace. It is not configured");
  console.error("with defaults, because a default in a public repository is not a credential.");
  process.exit(1);
}

cfg.name = "pawspace-staging";
cfg.topLevelName = "pawspace-staging";
cfg.d1_databases = [{ binding: "DB", database_name: "pawspace-staging", database_id: d1Id }];

// Only NON-SECRET configuration is serialized into wrangler.json. The three UAT credentials are
// validated above (fail-closed) but are DELIBERATELY NOT written here: wrangler.json is a generated
// deploy artifact, and anything under `vars` becomes a plaintext Worker variable readable in the
// dashboard, in the file, and in any build log that echoes it. The credentials are installed into the
// Worker runtime as Cloudflare Worker SECRETS (`wrangler secret put`) by the deploy step instead.
cfg.vars = {
  ...(cfg.vars || {}),
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_UAT_LOGIN: "on",
};
// Defensively strip the credentials in case an inherited cfg.vars already carried them — no code path
// may leave a UAT credential in the serialized config.
for (const [name] of REQUIRED) delete cfg.vars[name];
writeFileSync(path, JSON.stringify(cfg));

// Report only what is safe to read in a build log. The access code used to be printed here, which put
// it in every CI log for anyone with repository read access.
console.log(`Staging config written → name=pawspace-staging, DB=${d1Id}, PAWSPACE_PAYMENT_ENV=sandbox, UAT_LOGIN=on`);
console.log("UAT credentials were validated from the environment, are NOT written to wrangler.json, and are installed separately as Cloudflare Worker secrets — nothing secret is logged.");
