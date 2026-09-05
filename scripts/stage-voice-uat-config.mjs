// Apply the voice-specific overlay to an ALREADY isolated staging build.
// Run after scripts/stage-config.mjs and only from the explicit voice-UAT workflow.
// Provider credentials and recipient values remain encrypted Worker secrets.
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));
const callback = String(process.env.PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT || "").trim();
const streamUrl = String(process.env.PAWSPACE_VOICE_STREAM_URL_UAT || "").trim();
const approved = String(process.env.PAWSPACE_VOICE_UAT_APPROVED || "").trim().toLowerCase() === "true";
const customerId = String(process.env.PAWSPACE_VOICE_UAT_CUSTOMER_ID || "").trim();
const bookingId = String(process.env.PAWSPACE_VOICE_UAT_BOOKING_ID || "").trim();
const cityId = String(process.env.PAWSPACE_VOICE_UAT_CITY_ID || "").trim();
const consentSource = String(process.env.PAWSPACE_VOICE_UAT_CONSENT_SOURCE || "").trim();

const problems = [];
if (cfg.name !== "pawspace-staging" || cfg.vars?.PAWSPACE_DEPLOYMENT_ENV !== "staging") problems.push("base config is not the isolated pawspace-staging profile");
if (!approved) problems.push("PAWSPACE_VOICE_UAT_APPROVED must be exactly true for this explicit workflow");
try { if (!callback || new URL(callback).protocol !== "https:") problems.push("PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT must be an absolute https URL"); } catch { problems.push("PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT is malformed"); }
try { if (!streamUrl || new URL(streamUrl).protocol !== "wss:") problems.push("PAWSPACE_VOICE_STREAM_URL_UAT must be an absolute wss URL"); } catch { problems.push("PAWSPACE_VOICE_STREAM_URL_UAT is malformed"); }
if (!customerId || !bookingId || !cityId) problems.push("voice UAT customer, booking and city IDs must be configured");
if (consentSource.length < 4) problems.push("PAWSPACE_VOICE_UAT_CONSENT_SOURCE must identify the real consent evidence source");
if (problems.length) {
  console.error("Refusing to activate voice UAT:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

cfg.vars = {
  ...cfg.vars,
  PAWSPACE_VOICE_ENV: "uat",
  PAWSPACE_VOICE_UAT_APPROVED: "true",
  PAWSPACE_VOICE_UAT_AUTORUN: "true",
  PAWSPACE_VOICE_UAT_CONSENT_CONFIRMED: "true",
  PAWSPACE_VOICE_UAT_CONSENT_SOURCE: consentSource,
  PAWSPACE_VOICE_UAT_CUSTOMER_ID: customerId,
  PAWSPACE_VOICE_UAT_BOOKING_ID: bookingId,
  PAWSPACE_VOICE_UAT_CITY_ID: cityId,
  PAWSPACE_VOICE_UAT_RUN_AT: "2026-09-06T02:30:00.000Z",
  PAWSPACE_VOICE_STATUS_CALLBACK_URL: callback,
  PAWSPACE_VOICE_STREAM_URL: streamUrl,
  VOICE_STT_MODEL: "@cf/openai/whisper-large-v3-turbo",
  VOICE_TTS_MODEL: "@cf/myshell-ai/melotts",
  VOICE_CARRIER_TTS_MODEL: "@cf/deepgram/aura-2-en",
  VOICE_SPEECH_TIMEOUT_MS: "12000",
};
cfg.ai = { binding: "AI" };

for (const secretName of [
  "PAWSPACE_VOICE_UAT_ALLOWLIST", "PAWSPACE_VOICE_UAT_TEST_NUMBER",
  "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID",
  "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET",
]) delete cfg.vars[secretName];

writeFileSync(path, JSON.stringify(cfg));
console.log("Voice UAT overlay applied: bidirectional AgentStream enabled, carrier linear16 TTS pinned, one-shot 08:00 IST queue armed; secret values withheld.");
