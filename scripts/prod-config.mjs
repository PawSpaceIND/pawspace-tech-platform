// Patch the vinext/@cloudflare/vite-plugin build output (dist/server/wrangler.json) for the PRODUCTION
// deploy: rename the worker to pawspace-prod-bengaluru, point the DB binding at the production D1, and
// declare a production runtime. Run AFTER `npm run build`, BEFORE `wrangler deploy`.
//
// This is deliberately NOT stage-config.mjs with different strings. Staging may assume a sandbox; a
// production deploy may assume nothing. Every value that decides whether real money moves, whether a
// real message is sent, or who may sign in is REQUIRED from the environment, and its absence refuses
// the deploy rather than falling back. A default is how a pilot ends up quietly running on sandbox
// payments, or quietly running on live ones.
//
// Required env:
//   PRODUCTION_D1_ID
//   PAWSPACE_PAYMENT_ENV            explicit: "live" or "sandbox" — never inferred
//   PAWSPACE_COMMUNICATION_ENV      explicit: "live" or "sandbox" — never inferred
//   PAWSPACE_MAPS_ENV               explicit: "live" or "sandbox" — never inferred
// Refused if present:
//   STAGING_D1_ID / RELEASE_PREVIEW_D1_ID equal to PRODUCTION_D1_ID (isolation)
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

export const PRODUCTION_WORKER_NAME = "pawspace-prod-bengaluru";

/* Vars that only ever make sense on a developer's machine or in a UAT environment. PAWSPACE_LOCAL_PREVIEW
 * is the runtime switch for an AUTHENTICATION-FREE actor; PAWSPACE_UAT_LOGIN grants staff access via a
 * shared access code. Neither belongs anywhere near production. Listed and enforced rather than assumed
 * absent, because vite.config.ts writes some of these into the build output. */
export const FORBIDDEN_IN_PRODUCTION = [
  "PAWSPACE_LOCAL_PREVIEW",
  "PAWSPACE_UAT_LOGIN",
  "PAWSPACE_SCHEDULING_ENV",
  "META_WHATSAPP_UAT_DELIVERY_ENABLED",
  "PAWSPACE_MEDIA_ENV",
];

/* Values that decide real-world consequences. Each must be stated; none is defaulted. */
export const REQUIRED_EXPLICIT = [
  ["PAWSPACE_PAYMENT_ENV", ["live", "sandbox"], "Decides whether a customer's card is actually charged."],
  ["PAWSPACE_COMMUNICATION_ENV", ["live", "sandbox"], "Decides whether a real SMS or WhatsApp message reaches a real person."],
  ["PAWSPACE_MAPS_ENV", ["live", "sandbox"], "Decides whether provider location and ETA are real."],
];

const problems = [];

const d1Id = String(process.env.PRODUCTION_D1_ID || "").trim();
if (!d1Id || d1Id === "00000000-0000-4000-8000-000000000000") {
  problems.push("PRODUCTION_D1_ID is not set. There is deliberately no default: a production deploy pointed at the wrong database is the one mistake with no rollback.");
}

/* Isolation, inverted. deploy-staging refuses to touch production; this refuses to touch anything that
 * is NOT production. A production worker bound to the staging D1 would serve staging's seeded fixtures
 * to real customers. */
for (const name of ["STAGING_D1_ID", "RELEASE_PREVIEW_D1_ID", "SHARED_STAGING_D1_ID"]) {
  const other = String(process.env[name] || "").trim();
  if (other && d1Id && other === d1Id) {
    problems.push(`PRODUCTION_D1_ID is the same database as ${name}. Production must not share a database with a non-production environment.`);
  }
}

const explicit = {};
for (const [name, allowed, why] of REQUIRED_EXPLICIT) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) {
    problems.push(`${name} is not set. ${why} State it explicitly; it is not inferred from the environment.`);
  } else if (!allowed.includes(value)) {
    problems.push(`${name} is "${value}", which is not one of: ${allowed.join(", ")}. ${why}`);
  } else {
    explicit[name] = value;
  }
}

if (problems.length) {
  console.error("Refusing to configure the production deploy:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nA production deploy decides whether real money moves and whether real people are");
  console.error("messaged. Nothing here falls back to a default, because a default is a decision");
  console.error("nobody made.");
  process.exit(1);
}

cfg.name = PRODUCTION_WORKER_NAME;
cfg.topLevelName = PRODUCTION_WORKER_NAME;
cfg.d1_databases = [{ binding: "DB", database_name: PRODUCTION_WORKER_NAME, database_id: d1Id }];

/* Production DECLARES its complete var set, exactly as staging now does. Nothing is inherited from the
 * build output: vite.config.ts writes development values there, and that is how PAWSPACE_LOCAL_PREVIEW
 * reached a deployed environment once already. */
cfg.vars = {
  PAWSPACE_DEPLOYMENT_ENV: "production",
  PAWSPACE_PAYMENT_ENV: explicit.PAWSPACE_PAYMENT_ENV,
  PAWSPACE_COMMUNICATION_ENV: explicit.PAWSPACE_COMMUNICATION_ENV,
  PAWSPACE_MAPS_ENV: explicit.PAWSPACE_MAPS_ENV,
};

if (String(process.env.PRODUCTION_R2_BUCKET_NAME || "").trim()) {
  cfg.r2_buckets = [{ binding: "PAWSPACE_MEDIA_BUCKET", bucket_name: String(process.env.PRODUCTION_R2_BUCKET_NAME).trim() }];
}

/* Belt and braces. The declaration above cannot carry a forbidden var today; this refuses the deploy
 * outright if one ever appears rather than shipping it. */
const forbidden = FORBIDDEN_IN_PRODUCTION.filter((name) => name in cfg.vars);
if (forbidden.length) {
  console.error(`Refusing to configure the production deploy: forbidden vars present: ${forbidden.join(", ")}`);
  console.error("These grant preview authority, shared-code sign-in, or UAT delivery behaviour and must never be deployed to production.");
  process.exit(1);
}

writeFileSync(path, JSON.stringify(cfg));

console.log(`Production config written → name=${PRODUCTION_WORKER_NAME}`);
console.log(`  payment=${explicit.PAWSPACE_PAYMENT_ENV} communication=${explicit.PAWSPACE_COMMUNICATION_ENV} maps=${explicit.PAWSPACE_MAPS_ENV}`);
console.log("  UAT login, local preview, UAT media and UAT WhatsApp delivery are absent by declaration.");
console.log("Database id is NOT logged. Credentials are uploaded as Worker secrets and are never written to wrangler.json.");
