import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installAiHooks, freshAiDb, seedCustomer } from "./helpers/ai-harness.mjs";

/*
 * Default the certification environment when the runner has not declared one.
 *
 * These two assertions are a guard, not a preference: this suite must never certify anything against
 * a production environment. But a bare `npm test` on a developer machine sets neither variable, so the
 * guard was failing the whole file before a single test ran — `main` was red out of the box for
 * everyone running the suite locally.
 *
 * `||` fills in ONLY when the variable is absent. An explicitly declared environment still reaches the
 * assertions below unchanged, so a run with APP_ENV=production still fails exactly as it did before.
 * The guard keeps its teeth where it matters; it just no longer punishes the default local run.
 */
process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";

assert.equal(process.env.APP_ENV, "staging", "webhook certification must run in APP_ENV=staging");
assert.equal(process.env.FORBID_PRODUCTION, "true", "webhook certification must run with FORBID_PRODUCTION=true");

installAiHooks();

// Preserve the existing source-level security contract under the exact certification filename.
await import("./meta-whatsapp-webhook.test.mjs");

const customer360 = await import("../lib/customer-360.ts");
const adapter = await import("../lib/whatsapp-uat-adapter.ts");
const conversationControl = await import("../lib/whatsapp-conversation-control.ts");
const route = await import("../app/api/whatsapp/meta-webhook/route.ts");

const APP_SECRET = "staging-certification-secret-not-a-provider-key";
const WEBHOOK_URL = "https://pawspace-staging.invalid/api/whatsapp/meta-webhook";
const CUSTOMER_ID = "CUS-WA-SEC-1";
const THREAD_ID = "THREAD-WA-SEC-1";
const PHONE = "9876500091";

const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
const sign = (rawBody) => `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;

async function world() {
  const { sqlite, db } = freshAiDb({ META_WHATSAPP_APP_SECRET: APP_SECRET });
  seedCustomer(sqlite, CUSTOMER_ID, "Webhook Security", PHONE);
  await customer360.ensureCustomer360Tables(db);
  await adapter.ensureWhatsAppUatTables(db);
  await conversationControl.ensureWhatsAppConversationControl(db);

  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','webhook-security-test',?)")
    .run(CUSTOMER_ID, now);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open',NULL,NULL,?,?)")
    .run(THREAD_ID, CUSTOMER_ID, now, now);
  sqlite.prepare("INSERT INTO whatsapp_conversation_routing_modes (thread_id,mode,updated_by,reason,updated_at) VALUES (?,'chatbot_only','webhook-security-test','staging runtime queue assertion',?)")
    .run(THREAD_ID, now);

  return { sqlite, db };
}

function validInboundBody() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: `wamid.SECURITY.${Date.now()}`,
            from: `91${PHONE}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: "grooming" },
          }],
        },
      }],
    }],
  });
}

async function post(rawBody, signature) {
  const headers = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return route.POST(new Request(WEBHOOK_URL, { method: "POST", headers, body: rawBody }));
}

test("Meta webhook rejects missing, malformed and mismatched signatures with zero D1 queue writes; valid signature queues exactly one reply", async () => {
  const { sqlite } = await world();
  const rawBody = validInboundBody();

  const invalidCases = [
    ["missing", undefined],
    ["malformed", "sha256=not-a-valid-hmac"],
    ["mismatched", `sha256=${"0".repeat(64)}`],
  ];

  for (const [label, signature] of invalidCases) {
    const beforeOutbox = count(sqlite, "communication_outbox");
    const beforeEvents = count(sqlite, "whatsapp_uat_events");
    const beforeMessages = count(sqlite, "communication_messages");
    const response = await post(rawBody, signature);

    assert.equal(response.status, 401, `${label} signature must fail closed with HTTP 401`);
    assert.equal(count(sqlite, "communication_outbox"), beforeOutbox, `${label} signature must write zero outbound queue rows`);
    assert.equal(count(sqlite, "whatsapp_uat_events"), beforeEvents, `${label} signature must write zero webhook event rows`);
    assert.equal(count(sqlite, "communication_messages"), beforeMessages, `${label} signature must write zero canonical messages`);
  }

  const beforeOutbox = count(sqlite, "communication_outbox");
  const response = await post(rawBody, sign(rawBody));
  const body = await response.json();

  assert.equal(response.status, 200, "valid signature must be accepted");
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 1);
  assert.equal(count(sqlite, "whatsapp_uat_events"), 1, "valid webhook must persist its inbound event exactly once");
  assert.equal(count(sqlite, "communication_outbox"), beforeOutbox + 1, "valid webhook must queue exactly one governed WhatsApp reply");

  const queued = sqlite.prepare("SELECT o.status,m.direction,m.channel,m.provider FROM communication_outbox o JOIN communication_messages m ON m.id=o.message_id ORDER BY m.created_at DESC LIMIT 1").get();
  assert.deepEqual({ ...queued }, { status: "queued", direction: "outbound", channel: "whatsapp", provider: "meta_whatsapp" });
});
