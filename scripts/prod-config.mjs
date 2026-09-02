/**
 * Production config hardening wrapper.
 * Runtime credentials are Worker secrets, never wrangler vars. The core config writes the production
 * D1 + explicit runtime modes; this wrapper then proves no Interakt credential leaked into plaintext.
 */
import { readFileSync } from "node:fs";

export const INTERAKT_PRODUCTION_SECRET_NAMES = [
  "INTERAKT_API_KEY",
  "INTERAKT_WEBHOOK_SECRET",
];

await import("./prod-config-core.mjs");
const cfg = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
const vars = cfg.vars || {};
const leaked = INTERAKT_PRODUCTION_SECRET_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(vars, name));
if (leaked.length) {
  console.error(`Refusing production config: Interakt secrets must be Cloudflare Worker secrets, not plaintext vars: ${leaked.join(", ")}`);
  process.exit(1);
}
console.log("Interakt credential binding policy certified: secrets are excluded from wrangler.json and must be installed with wrangler secret put.");
