// Patch the vinext build output (dist/server/wrangler.json) for the DEDICATED RELEASE PREVIEW deploy:
// its own Worker name, its own D1, sandbox payments, and every live-side-effect flag off. Run AFTER
// `npm run build`, BEFORE `wrangler deploy`.
//
// This is deliberately NOT scripts/stage-config.mjs. That one configures the SHARED pawspace-staging
// Worker and D1; a release preview that reused them would overwrite whatever another workstream had
// deployed there and write into a database other testers are reading.
//
// ISOLATION IS A PRECONDITION, NOT A LABEL. The preview D1 id is compared against the production D1 id
// here, before anything is written or deployed, and the script exits non-zero if they match or if
// either is missing. Neither id is ever printed — the only isolation output is the word true or false.
//
// Required env:
//   RELEASE_PREVIEW_WORKER_NAME  the dedicated Worker (must not be the shared staging Worker)
//   RELEASE_PREVIEW_D1_ID        the dedicated preview D1 (from: npx wrangler d1 create <name>)
//   PRODUCTION_D1_ID             production's D1 id, supplied ONLY so this script can refuse to match it
//   RELEASE_SHA                  the exact commit being previewed, recorded as a safe version marker
//   PAWSPACE_UAT_ACCESS_CODE / PAWSPACE_UAT_SIGNING_KEY / PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT
//                                validated for strength HERE, and never written into the artifact —
//                                the deploy installs them as encrypted Worker secrets instead
import { readFileSync, writeFileSync } from "node:fs";

// The artifact path is an ARGUMENT, not a constant, because this tool and the thing it configures no
// longer live in the same checkout. The workflow runs the tool from the infrastructure checkout and
// points it at the CANDIDATE's build output; a hardcoded relative path would silently resolve inside
// whichever directory the step happened to start in.
const path = process.argv[2] || "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — pass the candidate's built wrangler.json, and run "npm run build" there first.`); process.exit(1); }

const read = (name) => String(process.env[name] || "").trim();
const workerName = read("RELEASE_PREVIEW_WORKER_NAME");
const previewD1 = read("RELEASE_PREVIEW_D1_ID");
const productionD1 = read("PRODUCTION_D1_ID");
const releaseSha = read("RELEASE_SHA");

/** Worker names this deploy must never take over. Reusing one is the failure this script exists for. */
export const RESERVED_WORKER_NAMES = ["pawspace", "pawspace-production", "pawspace-prod", "pawspace-staging", "pawspace-uat"];

/** The floor scripts/stage-config.mjs enforces for the same three credentials. Kept identical. */
export const CREDENTIAL_MIN_LENGTH = 32;

// Written as a prefix and a suffix so a credential's full variable name never sits next to a quoted
// literal: tests/staging-auth-secrets.test.mjs walks every file under scripts/ looking for exactly that
// shape, because it is what a committed fallback looks like. That guard should stay blunt.
const CREDENTIAL_SUFFIXES = ["UAT_ACCESS_CODE", "UAT_SIGNING_KEY", "IDENTITY_ASSERTION_SECRET_UAT"];
export const UAT_CREDENTIALS = CREDENTIAL_SUFFIXES.map((suffix) => `PAWSPACE_${suffix}`);

/**
 * A credential that has ever been committed to this repository is public forever. Rather than repeat
 * the burned values here — which would put them in a third file and blunt the repository-wide guard —
 * this refuses the SHAPE they all share: a hand-written value beginning with the project's own name.
 * `openssl rand -hex 32` never produces one, so nothing legitimate is caught by it.
 *
 * This runs here, before the deploy, because the same three credentials are about to be installed onto
 * the preview Worker as secrets. A preview signed with a public key is a preview anybody can sign into.
 */
export function credentialProblem(name, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return `${name} is not set. Supply it from a GitHub Actions secret (secrets.${name}); there is deliberately no default.`;
  if (trimmed.length < CREDENTIAL_MIN_LENGTH) return `${name} is too short (needs at least ${CREDENTIAL_MIN_LENGTH} characters).`;
  if (/^pawspace[-_]/i.test(trimmed)) return `${name} looks like a hand-written project credential. Every credential that has been committed to this repository began that way, and those are public forever. Generate a fresh one: openssl rand -hex 32`;
  return null;
}

const problems = [];
if (!workerName) problems.push("RELEASE_PREVIEW_WORKER_NAME is not set.");
if (workerName && RESERVED_WORKER_NAMES.includes(workerName.toLowerCase())) {
  problems.push(`RELEASE_PREVIEW_WORKER_NAME is "${workerName}", which is a shared or production Worker. The release preview must have a Worker of its own.`);
}
if (!previewD1) problems.push("RELEASE_PREVIEW_D1_ID is not set (from: npx wrangler d1 create <preview-db>).");
if (!productionD1) problems.push("PRODUCTION_D1_ID is not set. It is required so this script can PROVE the preview D1 is not production; without it, isolation is an assumption.");
if (!releaseSha || !/^[0-9a-f]{40}$/i.test(releaseSha)) problems.push("RELEASE_SHA must be the full 40-character commit sha being previewed.");

// The isolation decision. Reported as a boolean and nothing else — printing either id, even partially,
// would put a database identifier into a build log that anyone with repository read access can see.
//
// It covers BOTH halves of what isolation means here: a database that is provably not production, and a
// Worker that is not one production or shared staging already answers to. Deploying a preview over the
// shared staging Worker is not "isolated but misconfigured" — it is the failure itself.
const separateDatabase = Boolean(previewD1 && productionD1 && previewD1 !== productionD1);
if (previewD1 && productionD1 && !separateDatabase) {
  problems.push("RELEASE_PREVIEW_D1_ID equals PRODUCTION_D1_ID. Refusing to migrate or deploy against production data.");
}
const isolated = separateDatabase && Boolean(workerName) && !RESERVED_WORKER_NAMES.includes(workerName.toLowerCase());

// A weak or public credential refuses the deploy without making the environment any less isolated, so
// it is reported as its own class of problem and leaves the verdict above alone.
for (const name of UAT_CREDENTIALS) {
  const problem = credentialProblem(name, process.env[name]);
  if (problem) problems.push(problem);
}

if (problems.length) {
  console.error(`isolated=${isolated}`);
  console.error("Refusing to configure the release preview deploy:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

cfg.name = workerName;
cfg.topLevelName = workerName;
cfg.d1_databases = [{ binding: "DB", database_name: workerName, database_id: previewD1 }];

// Sandbox money, and every outbound live effect off. These are NON-SECRET switches, so they belong in
// vars; the UAT credentials are installed separately as encrypted Worker secrets and are never written
// into this generated artifact.
cfg.vars = {
  ...(cfg.vars || {}),
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_UAT_LOGIN: "on",
  PAWSPACE_RELEASE_SHA: releaseSha,
  PAWSPACE_ENVIRONMENT: "release-preview",
  PAWSPACE_LIVE_PAYMENTS: "false",
  PAWSPACE_LIVE_PAYOUTS: "false",
  PAWSPACE_LIVE_REFUNDS: "false",
  PAWSPACE_LIVE_BANK_INSTRUCTIONS: "false",
  PAWSPACE_LIVE_WHATSAPP: "false",
  PAWSPACE_LIVE_SMS: "false",
  PAWSPACE_LIVE_EMAIL: "false",
  PAWSPACE_LIVE_PUSH: "false",
  PAWSPACE_LIVE_TELEPHONY: "false",
  PAWSPACE_LIVE_KYC: "false",
  PAWSPACE_LIVE_ESIGN: "false",
  PAWSPACE_LIVE_MAPS_BILLING: "false",
  PAWSPACE_LIVE_EXTERNAL_AI: "false",
  PAWSPACE_LIVE_ACCOUNTING: "false",
  PAWSPACE_LIVE_TAX_POSTING: "false",
  PAWSPACE_PROVIDER_MARKETPLACE_LIVE: "false",
  PAWSPACE_PROVIDER_ORDER_ELIGIBLE: "false",
  PAWSPACE_PROVIDER_ACTIVATION: "uat_ready",
};
// Defensive: a credential must never survive into the serialized deploy artifact, whatever an
// inherited cfg.vars carried. Deleted by property rather than from a list of quoted names, because a
// name string sitting next to another quoted string is exactly the shape the committed-fallback guard
// in tests/staging-auth-secrets.test.mjs looks for — and that guard should stay blunt.
delete cfg.vars.PAWSPACE_UAT_ACCESS_CODE;
delete cfg.vars.PAWSPACE_UAT_SIGNING_KEY;
delete cfg.vars.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT;
delete cfg.vars.CLOUDFLARE_API_TOKEN;
writeFileSync(path, JSON.stringify(cfg));

// Only what is safe to read in a build log: no ids, no credentials.
console.log("isolated=true");
console.log(`Release preview config written → worker=${workerName}, DB=<preview>, payments=sandbox, live effects=off, sha=${releaseSha}`);
