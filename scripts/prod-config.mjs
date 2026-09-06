// Patch the vinext/@cloudflare/vite-plugin build output (dist/server/wrangler.json) for production.
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
let cfg;
try { cfg = JSON.parse(readFileSync(path, "utf8")); }
catch { console.error(`Cannot read ${path} — run "npm run build" first.`); process.exit(1); }

export const PRODUCTION_WORKER_NAME = "pawspace-prod-bengaluru";
export const FORBIDDEN_IN_PRODUCTION = [
  "PAWSPACE_LOCAL_PREVIEW",
  "PAWSPACE_UAT_LOGIN",
  "PAWSPACE_SCHEDULING_ENV",
  "META_WHATSAPP_UAT_DELIVERY_ENABLED",
  "PAWSPACE_MEDIA_ENV",
];
export const REQUIRED_EXPLICIT = [
  ["PAWSPACE_PAYMENT_ENV", ["sandbox"], "Live payments remain disabled until a separately authorized pilot activation."],
  ["PAWSPACE_COMMUNICATION_ENV", ["live", "sandbox"], "Decides whether a real SMS or WhatsApp message reaches a real person."],
  ["PAWSPACE_MAPS_ENV", ["live", "sandbox"], "Decides whether provider location and ETA are real."],
];

const problems = [];
const d1Id = String(process.env.PRODUCTION_D1_ID || "").trim();
if (!d1Id || d1Id === "00000000-0000-4000-8000-000000000000") problems.push("PRODUCTION_D1_ID is not set. There is deliberately no default.");
for (const name of ["STAGING_D1_ID", "RELEASE_PREVIEW_D1_ID", "SHARED_STAGING_D1_ID"]) {
  const other = String(process.env[name] || "").trim();
  if (other && d1Id && other === d1Id) problems.push(`PRODUCTION_D1_ID is the same database as ${name}. Production must not share a database with a non-production environment.`);
}

const explicit = {};
for (const [name, allowed, why] of REQUIRED_EXPLICIT) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) problems.push(`${name} is not set. ${why} State it explicitly; it is not inferred from the environment.`);
  else if (!allowed.includes(value)) problems.push(`${name} is "${value}", which is not one of: ${allowed.join(", ")}. ${why}`);
  else explicit[name] = value;
}

const paymentLiveApproved = String(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED || "false").trim().toLowerCase();
if (paymentLiveApproved !== "false") problems.push("PAWSPACE_PAYMENT_LIVE_APPROVED must remain false until a separately authorized live-payment pilot activation.");

const pilotBookingIdsRaw = String(process.env.PAWSPACE_PAYMENT_PILOT_BOOKING_IDS || "").trim();
let pilotBookingIdCount = 0;
if (pilotBookingIdsRaw) {
  const ids = pilotBookingIdsRaw.split(",").map((value) => value.trim()).filter(Boolean);
  pilotBookingIdCount = ids.length;
  if (ids.length < 5 || ids.length > 20) problems.push("PAWSPACE_PAYMENT_PILOT_BOOKING_IDS must contain between 5 and 20 booking IDs when configured.");
  if (new Set(ids).size !== ids.length) problems.push("PAWSPACE_PAYMENT_PILOT_BOOKING_IDS must not contain duplicate booking IDs.");
  if (ids.some((id) => id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) problems.push("PAWSPACE_PAYMENT_PILOT_BOOKING_IDS contains an invalid booking ID.");
  const knownSyntheticFixtures = new Set(["PILOT-1", "PILOT-2", "PILOT-3", "PILOT-4", "PILOT-5"]);
  if (ids.some((id) => knownSyntheticFixtures.has(id))) problems.push("PAWSPACE_PAYMENT_PILOT_BOOKING_IDS contains a known synthetic PILOT-* fixture ID; production requires an explicitly approved real booking cohort.");
}

// Voice defaults are intentionally different from the real-world modes above: an omitted voice input
// means disabled, never live. During controlled validation the production artifact may be configured as
// UAT, but the existing voice gate still additionally requires the UAT approval flag, allow-list,
// callback URL and provider secrets. Live is not accepted by this deploy configurator yet.
const voiceEnv = String(process.env.PAWSPACE_VOICE_ENV || "disabled").trim().toLowerCase();
const voiceUatApproved = String(process.env.PAWSPACE_VOICE_UAT_APPROVED || "false").trim().toLowerCase();
if (!["disabled", "uat"].includes(voiceEnv)) problems.push("PAWSPACE_VOICE_ENV must be disabled or uat for the Bengaluru pilot production artifact; live activation remains a separate release gate.");
if (!["true", "false"].includes(voiceUatApproved)) problems.push("PAWSPACE_VOICE_UAT_APPROVED must be true or false.");
if (voiceEnv === "disabled" && voiceUatApproved === "true") problems.push("PAWSPACE_VOICE_UAT_APPROVED cannot be true while PAWSPACE_VOICE_ENV is disabled.");

if (problems.length) {
  console.error("Refusing to configure the production deploy:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

cfg.name = PRODUCTION_WORKER_NAME;
cfg.topLevelName = PRODUCTION_WORKER_NAME;
cfg.d1_databases = [{ binding: "DB", database_name: PRODUCTION_WORKER_NAME, database_id: d1Id }];
cfg.vars = {
  PAWSPACE_DEPLOYMENT_ENV: "production",
  PAWSPACE_PAYMENT_ENV: explicit.PAWSPACE_PAYMENT_ENV,
  PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  PAWSPACE_COMMUNICATION_ENV: explicit.PAWSPACE_COMMUNICATION_ENV,
  PAWSPACE_MAPS_ENV: explicit.PAWSPACE_MAPS_ENV,
  PAWSPACE_VOICE_ENV: voiceEnv,
  PAWSPACE_VOICE_UAT_APPROVED: voiceUatApproved,
};

if (String(process.env.PRODUCTION_R2_BUCKET_NAME || "").trim()) cfg.r2_buckets = [{ binding: "PAWSPACE_MEDIA_BUCKET", bucket_name: String(process.env.PRODUCTION_R2_BUCKET_NAME).trim() }];
const forbidden = FORBIDDEN_IN_PRODUCTION.filter((name) => name in cfg.vars);
if (forbidden.length) {
  console.error(`Refusing to configure the production deploy: forbidden vars present: ${forbidden.join(", ")}`);
  process.exit(1);
}
writeFileSync(path, JSON.stringify(cfg));
console.log(`Production config written → name=${PRODUCTION_WORKER_NAME}`);
console.log(`  payment=${explicit.PAWSPACE_PAYMENT_ENV} liveApproved=false communication=${explicit.PAWSPACE_COMMUNICATION_ENV} maps=${explicit.PAWSPACE_MAPS_ENV}`);
console.log(`  voice=${voiceEnv} voiceUatApproved=${voiceUatApproved}`);
console.log(`  paymentPilotAllowlist=${pilotBookingIdsRaw ? `provided(${pilotBookingIdCount})` : "not-provided"} (value is handled as a Worker secret and is not written to wrangler vars)`);
console.log("Database id and credentials are NOT logged. Credentials are uploaded as Worker secrets.");
