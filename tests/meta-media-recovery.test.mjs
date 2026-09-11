import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installAiHooks, freshAiDb, seedCustomer } from "./helpers/ai-harness.mjs";
import { makeD1 } from "./helpers/taxi-harness.mjs";

process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";
process.env.PAWSPACE_LOCAL_PREVIEW = "off";
assert.equal(process.env.APP_ENV, "staging");
assert.equal(process.env.FORBID_PRODUCTION, "true");

installAiHooks();

const customer360 = await import("../lib/customer-360.ts");
const adapter = await import("../lib/whatsapp-uat-adapter.ts");
const security = await import("../lib/server-auth.ts");
const webhookRoute = await import("../app/api/whatsapp/meta-webhook/route.ts");
const crmChatRoute = await import("../app/api/crm/chat/route.ts");
const inboundProcessing = await import("../lib/meta-whatsapp-inbound-processing.ts");
const inboundQueue = await import("../lib/gateway-inbound-queue.ts");

const APP_SECRET = "staging-media-recovery-secret-not-a-provider-key";
const WEBHOOK_URL = "https://pawspace-staging.invalid/api/whatsapp/meta-webhook";
const CRM_URL = "https://ops.pawspace.example/api/crm/chat";
const CUSTOMER_ID = "CUS-WA-MEDIA-RECOVERY";
const PHONE = "9876500094";
const ACTOR = "media-recovery-audit@pawspace.test";

const sign = (rawBody) => `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
const payload = (row) => JSON.parse(String(row?.payload_json || "{}"));
const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);

function imageBody({ eventId = "wamid.MEDIA.RECOVERY", providerMediaId = "META-MEDIA-RECOVERY", caption = "Care photo" } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { messages: [{
      id: eventId,
      from: `91${PHONE}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "image",
      image: { id: providerMediaId, mime_type: "image/jpeg", caption },
    }] } }] }],
  });
}

async function world(extraEnv = {}) {
  const { sqlite } = freshAiDb({ META_WHATSAPP_APP_SECRET: APP_SECRET, ...extraEnv });
  const db = makeD1(sqlite);
  globalThis.__AI_DB__ = db;
  seedCustomer(sqlite, CUSTOMER_ID, "Media Recovery", PHONE);
  await customer360.ensureCustomer360Tables(db);
  await adapter.ensureWhatsAppUatTables(db);
  await security.ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MEDIA-RECOVERY',?,'Media Recovery Auditor','admin','active',?,?)").run(ACTOR, now, now);
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','media-recovery-test',?)").run(CUSTOMER_ID, now);
  return { sqlite, db };
}

async function post(rawBody) {
  return webhookRoute.POST(new Request(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) },
    body: rawBody,
  }));
}

function installSuccessfulMediaFetch(providerMediaId, bytes = new TextEncoder().encode("synthetic-jpeg-body")) {
  const original = globalThis.fetch;
  const calls = [];
  const downloadUrl = `https://lookaside.fbsbx.com/whatsapp_business/attachments/${providerMediaId}`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://graph.facebook.com/") && url.includes(`/${providerMediaId}?`)) {
      return Response.json({ id: providerMediaId, mime_type: "image/jpeg", file_size: bytes.byteLength, url: downloadUrl });
    }
    if (url === downloadUrl) return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    throw new Error(`unexpected media fetch: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function memoryBucket({ fail = false } = {}) {
  const puts = [];
  return {
    puts,
    bucket: {
      put: async (key, value, options) => {
        puts.push({ key, bytes: value.byteLength, options });
        if (fail) throw new Error("synthetic media storage failure");
      },
    },
  };
}

function queueRow(sqlite) {
  return sqlite.prepare("SELECT * FROM gateway_inbound_queue WHERE provider='meta_whatsapp' ORDER BY received_at DESC LIMIT 1").get();
}

function canonicalMediaMessage(sqlite, eventId = "wamid.MEDIA.RECOVERY") {
  return sqlite.prepare("SELECT * FROM communication_messages WHERE provider='meta_whatsapp' AND provider_reference=? ORDER BY created_at DESC LIMIT 1").get(eventId);
}

function makeRetryDue(sqlite, id) {
  sqlite.prepare("UPDATE gateway_inbound_queue SET next_attempt_at=? WHERE id=?").run(Date.now() - 1, id);
}

test("missing Meta media configuration persists one canonical pending message and keeps the signed webhook retryable", async () => {
  for (const variant of [
    { label: "token", env: {}, error: /access token/i },
    { label: "bucket", env: { META_WHATSAPP_ACCESS_TOKEN: "uat-media-token-not-a-live-key" }, error: /PAWSPACE_MEDIA_BUCKET/i },
  ]) {
    const { sqlite } = await world(variant.env);
    const rawBody = imageBody({ eventId: `wamid.MEDIA.CONFIG.${variant.label}`, providerMediaId: `META-MEDIA-CONFIG-${variant.label}` });
    const response = await post(rawBody);
    assert.equal(response.status, 503, `${variant.label} configuration gap must stay retryable`);

    const queued = queueRow(sqlite);
    assert.equal(queued.status, "RETRY");
    assert.equal(queued.attempts, 1);
    assert.equal(String(queued.raw_payload), rawBody, "retryable signed payload must not be scrubbed");
    assert.match(String(queued.last_error), variant.error);

    const message = canonicalMediaMessage(sqlite, `wamid.MEDIA.CONFIG.${variant.label}`);
    assert.ok(message?.id, "canonical inbound message must exist before provider media configuration is required");
    assert.equal(payload(message).mediaPending, true);
    assert.equal(count(sqlite, "communication_messages"), 1);
    assert.equal(count(sqlite, "communication_message_media"), 0);
    sqlite.close();
  }
});

test("configuration restoration replays the same signed event into the same message exactly once and a post-success duplicate stays idempotent", async () => {
  const providerMediaId = "META-MEDIA-RESTORE";
  const eventId = "wamid.MEDIA.RESTORE";
  const { sqlite, db } = await world();
  const rawBody = imageBody({ eventId, providerMediaId });
  assert.equal((await post(rawBody)).status, 503);
  const before = canonicalMediaMessage(sqlite, eventId);
  assert.ok(before?.id);
  const immediateDuplicate = await post(rawBody);
  assert.equal(immediateDuplicate.status, 202, "backoff must prevent a duplicate from bypassing next_attempt_at");
  assert.equal(canonicalMediaMessage(sqlite, eventId).id, before.id);
  assert.equal(count(sqlite, "communication_messages"), 1);

  const media = installSuccessfulMediaFetch(providerMediaId);
  const stored = memoryBucket();
  try {
    globalThis.__PAWSPACE_TEST_ENV__.META_WHATSAPP_ACCESS_TOKEN = "uat-media-token-not-a-live-key";
    globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_MEDIA_BUCKET = stored.bucket;
    const queued = queueRow(sqlite);
    makeRetryDue(sqlite, queued.id);

    const recovered = await inboundQueue.drainGatewayInboundQueue(db, {
      "meta-whatsapp-webhook": ({ rawBody: retryBody, headers }) => inboundProcessing.processQueuedMetaEnvelope({ ...globalThis.__PAWSPACE_TEST_ENV__, DB: db }, retryBody, headers),
    }, { now: Date.now(), workerPrefix: "media-recovery-test" });
    assert.deepEqual({ processed: recovered.processed, retried: recovered.retried, deadLettered: recovered.deadLettered }, { processed: 1, retried: 0, deadLettered: 0 });
    const after = canonicalMediaMessage(sqlite, eventId);
    assert.equal(after.id, before.id, "recovery must finish the original canonical message, not fork the conversation");
    const body = payload(after);
    assert.equal(body.mediaPending, undefined);
    assert.equal(body.media?.ref, `media:${before.id}`);
    assert.equal(count(sqlite, "communication_messages"), 1);
    assert.equal(count(sqlite, "communication_message_media"), 1);
    assert.equal(stored.puts.length, 1);

    const processed = queueRow(sqlite);
    assert.equal(processed.status, "PROCESSED");
    assert.equal(processed.raw_payload, null, "raw signed body is scrubbed only after recovery succeeds");

    const duplicate = await post(rawBody);
    assert.equal(duplicate.status, 200);
    assert.equal(count(sqlite, "communication_messages"), 1);
    assert.equal(count(sqlite, "communication_message_media"), 1);
    assert.equal(stored.puts.length, 1, "already-PROCESSED duplicate must not fetch or store media again");
  } finally {
    media.restore();
  }
});

test("media object-storage failure leaves the canonical message pending and a later due redelivery completes it", async () => {
  const providerMediaId = "META-MEDIA-STORAGE";
  const eventId = "wamid.MEDIA.STORAGE";
  const failing = memoryBucket({ fail: true });
  const { sqlite } = await world({
    META_WHATSAPP_ACCESS_TOKEN: "uat-media-token-not-a-live-key",
    PAWSPACE_MEDIA_BUCKET: failing.bucket,
  });
  const media = installSuccessfulMediaFetch(providerMediaId);
  const rawBody = imageBody({ eventId, providerMediaId });
  try {
    assert.equal((await post(rawBody)).status, 503);
    const message = canonicalMediaMessage(sqlite, eventId);
    assert.ok(message?.id);
    assert.equal(payload(message).mediaPending, true);
    assert.equal(count(sqlite, "communication_message_media"), 0);
    assert.equal(queueRow(sqlite).status, "RETRY");

    const recoveredBucket = memoryBucket();
    globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_MEDIA_BUCKET = recoveredBucket.bucket;
    makeRetryDue(sqlite, queueRow(sqlite).id);
    assert.equal((await post(rawBody)).status, 200);
    assert.equal(canonicalMediaMessage(sqlite, eventId).id, message.id);
    assert.equal(count(sqlite, "communication_message_media"), 1);
    assert.equal(recoveredBucket.puts.length, 1);
  } finally {
    media.restore();
  }
});

test("final D1 media commit rolls back atomically after object storage and retry converges on the deterministic object key", async () => {
  const providerMediaId = "META-MEDIA-ROLLBACK";
  const eventId = "wamid.MEDIA.ROLLBACK";
  const stored = memoryBucket();
  const { sqlite, db } = await world({
    META_WHATSAPP_ACCESS_TOKEN: "uat-media-token-not-a-live-key",
    PAWSPACE_MEDIA_BUCKET: stored.bucket,
  });
  const media = installSuccessfulMediaFetch(providerMediaId);
  const rawBody = imageBody({ eventId, providerMediaId });
  try {
    db.onSql("INSERT OR IGNORE INTO communication_message_media", () => { throw new Error("synthetic final media DB failure"); });
    assert.equal((await post(rawBody)).status, 503);
    const message = canonicalMediaMessage(sqlite, eventId);
    assert.ok(message?.id);
    assert.equal(count(sqlite, "communication_message_media"), 0, "failed batch must not leave half-written media metadata");
    assert.equal(payload(message).mediaPending, true, "failed batch must not clear the pending marker");
    assert.equal(stored.puts.length, 1, "object storage happened before the injected DB failure");

    makeRetryDue(sqlite, queueRow(sqlite).id);
    assert.equal((await post(rawBody)).status, 200);
    assert.equal(count(sqlite, "communication_message_media"), 1);
    assert.equal(payload(canonicalMediaMessage(sqlite, eventId)).mediaPending, undefined);
    assert.equal(stored.puts.length, 2);
    assert.equal(stored.puts[0].key, stored.puts[1].key, "retry must converge on the same deterministic private object key");
  } finally {
    media.restore();
  }
});

test("pending media is visible only through an authenticated row-scoped CRM conversation read", async () => {
  const eventId = "wamid.MEDIA.AUTH";
  const { sqlite } = await world();
  const rawBody = imageBody({ eventId, providerMediaId: "META-MEDIA-AUTH" });
  assert.equal((await post(rawBody)).status, 503);
  const message = canonicalMediaMessage(sqlite, eventId);
  assert.ok(message?.thread_id);

  const unauthenticated = await crmChatRoute.GET(new Request(`${CRM_URL}?threadId=${encodeURIComponent(message.thread_id)}`));
  assert.ok([401, 403].includes(unauthenticated.status), `unauthenticated transcript returned ${unauthenticated.status}`);

  const authenticated = await crmChatRoute.GET(new Request(`${CRM_URL}?threadId=${encodeURIComponent(message.thread_id)}`, {
    headers: { "oai-authenticated-user-email": ACTOR },
  }));
  assert.equal(authenticated.status, 200);
  const body = await authenticated.json();
  const visible = body.data.messages.find((item) => item.id === message.id);
  assert.ok(visible, "authorized staff transcript must include the canonical pending media message");
  assert.equal(visible.payload.mediaPending, true);
});

test("canonical message loss during final media commit cannot leave media metadata or mark inbound PROCESSED", async () => {
  const providerMediaId = "META-MEDIA-ORPHAN-GUARD", eventId = "wamid.MEDIA.ORPHAN.GUARD";
  const stored = memoryBucket();
  const { sqlite, db } = await world({ META_WHATSAPP_ACCESS_TOKEN: "uat-media-token-not-a-live-key", PAWSPACE_MEDIA_BUCKET: stored.bucket });
  const media = installSuccessfulMediaFetch(providerMediaId), rawBody = imageBody({ eventId, providerMediaId });
  try {
    db.onSql("INSERT OR IGNORE INTO communication_message_media", () => { sqlite.prepare("DELETE FROM communication_messages WHERE provider_reference=?").run(eventId); });
    assert.equal((await post(rawBody)).status, 503);
    assert.equal(count(sqlite, "communication_message_media"), 0, "media metadata must not survive without its canonical message");
    assert.equal(queueRow(sqlite).status, "RETRY", "gateway event must remain retryable rather than PROCESSED");
    assert.equal(stored.puts.length, 1, "private object write may have happened but canonical DB state remains uncommitted");
  } finally { media.restore(); }
});
