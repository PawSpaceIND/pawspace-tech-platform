// Apply the voice-specific overlay to an ALREADY isolated staging build.
// Run after scripts/stage-config.mjs and only from the explicit voice-UAT workflow.
// No credential values are written here: Exotel credentials and the recipient allow-list stay in
// encrypted Worker secrets. This file only enables UAT mode, binds Workers AI, selects models and pins
// the HTTPS carrier callback supplied by an administrator-controlled repository variable.
import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/server/wrangler.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));
const callback = String(process.env.PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT || "").trim();
const approved = String(process.env.PAWSPACE_VOICE_UAT_APPROVED || "").trim().toLowerCase() === "true";

const problems = [];
if (cfg.name !== "pawspace-staging" || cfg.vars?.PAWSPACE_DEPLOYMENT_ENV !== "staging") problems.push("base config is not the isolated pawspace-staging profile");
if (!approved) problems.push("PAWSPACE_VOICE_UAT_APPROVED must be exactly true for this explicit workflow");
try {
  if (!callback || new URL(callback).protocol !== "https:") problems.push("PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT must be an absolute https URL");
} catch { problems.push("PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT is malformed"); }
if (problems.length) {
  console.error("Refusing to activate voice UAT:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

cfg.vars = {
  ...cfg.vars,
  PAWSPACE_VOICE_ENV: "uat",
  PAWSPACE_VOICE_UAT_APPROVED: "true",
  PAWSPACE_VOICE_STATUS_CALLBACK_URL: callback,
  VOICE_STT_MODEL: "@cf/openai/whisper-large-v3-turbo",
  VOICE_TTS_MODEL: "@cf/myshell-ai/melotts",
  VOICE_SPEECH_TIMEOUT_MS: "12000",
};
// Wrangler's Workers AI binding. Without it /api/voice-speech remains fail-closed.
cfg.ai = { binding: "AI" };

// These values must remain encrypted secrets and must never become vars in the generated config.
for (const secretName of [
  "PAWSPACE_VOICE_UAT_ALLOWLIST",
  "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID",
  "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET",
]) delete cfg.vars[secretName];

writeFileSync(path, JSON.stringify(cfg));
console.log("Voice UAT overlay applied: mode=uat, Workers AI bound, STT/TTS models pinned, carrier callback configured; secret values withheld.");
