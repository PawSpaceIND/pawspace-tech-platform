import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../app/api/system-integration/route.ts", import.meta.url), "utf8");

test("system integration readiness uses direct Meta WhatsApp UAT configuration", () => {
  for (const name of [
    "META_WHATSAPP_UAT_ACCESS_TOKEN",
    "META_WHATSAPP_PHONE_NUMBER_ID",
    "META_WHATSAPP_WABA_ID",
    "META_WHATSAPP_APP_SECRET",
    "META_WHATSAPP_VERIFY_TOKEN",
    "META_WHATSAPP_UAT_ALLOWLIST",
    "META_WHATSAPP_TEMPLATE_ALLOWLIST",
  ]) assert.match(source, new RegExp(name));
  assert.match(source, /PAWSPACE_COMMUNICATION_ENV/);
  assert.match(source, /META_WHATSAPP_UAT_DELIVERY_ENABLED/);
  assert.match(source, /Meta WhatsApp UAT, SMS and telephony delivery/);
  assert.doesNotMatch(source, /runtime\.WATI_API_TOKEN|runtime\.WATI_TENANT_URL/);
});
