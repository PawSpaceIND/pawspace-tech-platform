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
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

const read = (name) => String(process.env[name] || "").trim();
const workerName = read("RELEASE_PREVIEW_WORKER_NAME");
const previewD1 = read("RELEASE_PREVIEW_D1_ID");
const productionD1 = read("PRODUCTION_D1_ID");
const releaseSha = read("RELEASE_SHA");

/** Worker names this deploy must never take over. Reusing one is the failure this script exists for. */
export const RESERVED_WORKER_NAMES = ["pawspace", "pawspace-production", "pawspace-prod", "pawspace-staging"];

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
const isolated = Boolean(previewD1 && productionD1 && previewD1 !== productionD1);
if (previewD1 && productionD1 && !isolated) {
  problems.push("RELEASE_PREVIEW_D1_ID equals PRODUCTION_D1_ID. Refusing to migrate or deploy against production data.");
}

if (problems.length) {
  console.error("isolated=false");
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
