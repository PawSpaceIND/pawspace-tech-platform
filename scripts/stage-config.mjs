// Patch the vinext/@cloudflare/vite-plugin build output (dist/server/wrangler.json) for the ISOLATED
// STAGING deploy: rename the worker to pawspace-staging, point the DB binding at the staging D1, and
// pin sandbox mode. Run AFTER `npm run build`, BEFORE `wrangler deploy` (from dist/server).
//
// Required env:
//   STAGING_D1_ID
//   PAWSPACE_UAT_ACCESS_CODE
//   PAWSPACE_UAT_SIGNING_KEY
//   PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

export const BURNED_CREDENTIALS = [
  "pawspace-uat-2026",
  "pawspace-staging-uat-signing-key-do-not-reuse-in-prod",
  "pawspace-staging-identity-assertion-uat-secret",
];

export function readSecret(env, name, minLength, purpose) {
  const value = String(env?.[name] || "").trim();
  if (!value) return { error: `${name} is not set. ${purpose} Provide it from a GitHub Actions secret (secrets.${name}); there is deliberately no default.` };
  if (value.length < minLength) return { error: `${name} is too short (needs at least ${minLength} characters). ${purpose}` };
  if (BURNED_CREDENTIALS.includes(value)) return { error: `${name} is one of the values that was committed to this repository and is therefore public. Generate a new one — for example: openssl rand -hex 32` };
  return { value };
}

const d1Id = String(process.env.STAGING_D1_ID || "").trim();
const r2BucketName = String(process.env.STAGING_R2_BUCKET_NAME || "").trim();
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

cfg.vars = {
  ...(cfg.vars || {}),
  PAWSPACE_DEPLOYMENT_ENV: "staging",
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_UAT_LOGIN: "on",
  PAWSPACE_MAPS_ENV: "sandbox",
  PAWSPACE_COMMUNICATION_ENV: "uat",
  META_WHATSAPP_UAT_DELIVERY_ENABLED: "true",
  PAWSPACE_MEDIA_ENV: "uat",
};
if (r2BucketName) {
  cfg.r2_buckets = [{ binding: "PAWSPACE_MEDIA_BUCKET", bucket_name: r2BucketName }];
}
for (const [name] of REQUIRED) delete cfg.vars[name];
writeFileSync(path, JSON.stringify(cfg));

console.log(`Staging config written → name=pawspace-staging, DB=${d1Id}, PAWSPACE_PAYMENT_ENV=sandbox, UAT_LOGIN=on, UAT integrations locked`);
console.log(`Private media binding: ${r2BucketName ? "configured" : "not configured"}`);
console.log("UAT credentials were validated from the environment, are NOT written to wrangler.json, and are uploaded as Cloudflare Worker secrets — nothing secret is logged.");
