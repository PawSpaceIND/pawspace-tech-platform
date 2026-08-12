// Patch the vinext/@cloudflare/vite-plugin build output (dist/server/wrangler.json) for the ISOLATED
// STAGING deploy: rename the worker to pawspace-staging, point the DB binding at the staging D1, and
// pin sandbox mode. Run AFTER `npm run build`, BEFORE `wrangler deploy` (from dist/server).
// Required env: STAGING_D1_ID — the id printed by `npx wrangler d1 create pawspace-staging`.
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

const d1Id = String(process.env.STAGING_D1_ID || "").trim();
if (!d1Id || d1Id === "00000000-0000-4000-8000-000000000000") {
  console.error('Set STAGING_D1_ID to your staging D1 id (from: npx wrangler d1 create pawspace-staging).');
  process.exit(1);
}

// Staging-only UAT sign-in config (see lib/uat-staging-auth.ts). These vars exist ONLY on staging, so
// the UAT login branch in resolveActor is dead code in production. Overridable via repo variables.
const accessCode = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "pawspace-uat-2026").trim();
const signingKey = String(process.env.PAWSPACE_UAT_SIGNING_KEY || "pawspace-staging-uat-signing-key-do-not-reuse-in-prod").trim();

cfg.name = "pawspace-staging";
cfg.topLevelName = "pawspace-staging";
cfg.d1_databases = [{ binding: "DB", database_name: "pawspace-staging", database_id: d1Id }];
cfg.vars = {
  ...(cfg.vars || {}),
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_UAT_LOGIN: "on",
  PAWSPACE_UAT_ACCESS_CODE: accessCode,
  PAWSPACE_UAT_SIGNING_KEY: signingKey,
};
writeFileSync(path, JSON.stringify(cfg));
console.log(`Staging config written → name=pawspace-staging, DB=${d1Id}, PAWSPACE_PAYMENT_ENV=sandbox, UAT_LOGIN=on, access code="${accessCode}"`);
