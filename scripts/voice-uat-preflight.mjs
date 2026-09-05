const value = name => String(process.env[name] || "").trim();

const telephony = [
  "EXOTEL_API_KEY",
  "EXOTEL_API_TOKEN",
  "EXOTEL_ACCOUNT_SID",
  "EXOTEL_CALLER_ID",
  "EXOTEL_VOICE_APP_ID",
  "EXOTEL_WEBHOOK_SECRET",
];

const requiredUat = [
  "PAWSPACE_VOICE_UAT_ALLOWLIST",
  "EXOTEL_CALLBACK_URL",
  "EXOTEL_AGENTSTREAM_WSS_URL",
  "UAT_CUSTOMER_ID",
  "UAT_BOOKING_ID",
  "UAT_CITY_ID",
  "UAT_CONSENT_SOURCE_REF",
];

const missing = [...telephony, ...requiredUat].filter(name => !value(name));
if (missing.length) {
  console.error(`Voice UAT preflight blocked; missing: ${missing.join(" ")}`);
  process.exit(1);
}

const allowlist = value("PAWSPACE_VOICE_UAT_ALLOWLIST")
  .split(/[,;\n]+/)
  .map(entry => entry.trim())
  .filter(Boolean);
if (allowlist.length !== 1 || !/^\+[1-9]\d{7,14}$/.test(allowlist[0])) {
  console.error("Voice UAT preflight blocked; PAWSPACE_VOICE_UAT_ALLOWLIST must contain exactly one E.164 number.");
  process.exit(1);
}

const requireUrl = (name, protocol) => {
  try {
    const parsed = new URL(value(name));
    if (parsed.protocol !== protocol) throw new Error("protocol");
  } catch {
    console.error(`Voice UAT preflight blocked; ${name} must be an absolute ${protocol.replace(":", "")} URL.`);
    process.exit(1);
  }
};
requireUrl("EXOTEL_CALLBACK_URL", "https:");
requireUrl("EXOTEL_AGENTSTREAM_WSS_URL", "wss:");

for (const name of ["UAT_CUSTOMER_ID", "UAT_BOOKING_ID", "UAT_CITY_ID"]) {
  if (value(name).length > 256) {
    console.error(`Voice UAT preflight blocked; ${name} is malformed.`);
    process.exit(1);
  }
}
if (value("UAT_CONSENT_SOURCE_REF").length < 4 || value("UAT_CONSENT_SOURCE_REF").length > 512) {
  console.error("Voice UAT preflight blocked; UAT_CONSENT_SOURCE_REF must identify the real consent evidence source.");
  process.exit(1);
}

console.log("Voice UAT preflight passed: 7/7 UAT parameters and 6/6 telephony prerequisites present; values withheld.");
