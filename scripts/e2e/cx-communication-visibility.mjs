import assert from "node:assert/strict";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { installAiHooks, freshAiDb, seedCustomer } from "../../tests/helpers/ai-harness.mjs";

installAiHooks();
process.env.PAWSPACE_LOCAL_PREVIEW = "off";
const { sqlite, db } = freshAiDb();
globalThis.__AI_DB__ = db;

const CUSTOMER = "CX-COMMS-CUS-001";
const BOOKING = "CX-COMMS-BKG-001";
const PAYMENT = "CX-COMMS-PAY-001";
const ACTOR = "cx-visibility-admin@pawspace.test";
const now = Date.now();

const { ensureSecurityTables, resolveActor } = await import("../../lib/server-auth.ts");
const { ensureWhatsAppUatTables } = await import("../../lib/whatsapp-uat-adapter.ts");
const { ensureCustomer360Tables } = await import("../../lib/customer-360.ts");
const { processGatewayEvent } = await import("../../lib/grooming-payment-reconciliation.ts");
const { enqueueCommunication, deadLetterOutbox } = await import("../../lib/communication-engine.ts");
const { dispatchMetaWhatsApp } = await import("../../lib/meta-whatsapp-dispatch.ts");
const conversations = await import("../../app/api/conversations/route.ts");
const controls = await import("../../app/api/whatsapp/conversation-control/route.ts");

await ensureSecurityTables(db);
await ensureWhatsAppUatTables(db);
await ensureCustomer360Tables(db);
seedCustomer(sqlite, CUSTOMER, "CX Visibility Customer", "9876500199");
sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-CX-VIS',?,'CX Visibility Admin','admin','active',?,?)").run(ACTOR, now, now);
const actor = await resolveActor(new Request("http://127.0.0.1/api/conversations", { headers: { "oai-authenticated-user-email": ACTOR } }));
assert.equal(actor.email, ACTOR);
assert.equal(actor.developmentPreview, false, "browser proof must use provisioned staff access");

sqlite.exec(`CREATE TABLE IF NOT EXISTS booking_payments (
 id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL,
 method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
)`);
sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,status,scheduled_start,scheduled_end,channel,total_amount,currency,provider_id,created_at,updated_at) VALUES (?,?,?,?,?,'confirmed',?,?,?,?,?,?,?,?)")
  .run(BOOKING, CUSTOMER, "grooming", "dog-basic", "Bath & Basic", new Date(now + 86400000).toISOString(), new Date(now + 90000000).toISOString(), "customer_app", 1350, "INR", "CX-PRV-001", now, now);
sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','card','prepaid','authorized','razorpay','cx-visibility-payment','{}',?,?)")
  .run(PAYMENT, BOOKING, CUSTOMER, 1350, 1350, now, now);

const capture = await processGatewayEvent(db, {
  provider: "razorpay", environment: "sandbox", eventId: "CX-RAZORPAY-CAPTURE-001", eventType: "payment.captured", bookingId: BOOKING,
  gatewayPaymentId: "pay_cx_visibility_001", amountSubunits: 135000, currency: "INR", signatureVerified: true, payloadHash: "cx-visibility-capture-hash",
  detail: { source: "playwright_e2e", simulatedWebhook: true },
});
assert.equal(capture.status, "processed", `Razorpay capture must process: ${JSON.stringify(capture)}`);
assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT).status, "captured");

const receipt = await enqueueCommunication(db, {
  customerId: CUSTOMER, cityId: "blr", channel: "whatsapp", purpose: "transactional", bookingId: BOOKING,
  idempotencyKey: `cx:receipt:${BOOKING}`, templateKey: "order_payment_captured_receipt",
  payload: { text: `Payment for grooming order ${BOOKING} received successfully. Your PawSpace receipt is recorded with this booking.` },
  createdBy: "razorpay_webhook",
});
assert.equal(receipt.status, "queued");
const messageId = String(receipt.messageId);
const threadId = String(receipt.threadId);
assert.ok(messageId && threadId, "receipt must create a booking-linked communication thread");

sqlite.prepare("INSERT OR REPLACE INTO customer_contact_preferences (customer_id,whatsapp_consent,opt_out,updated_by,updated_at) VALUES (?,1,0,'e2e',?)").run(CUSTOMER, now);
sqlite.prepare("INSERT OR REPLACE INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES (?,'meta_whatsapp',?)").run(CUSTOMER, now);
const meta = await dispatchMetaWhatsApp(db, {
  PAWSPACE_DEPLOYMENT_ENV: "production", PAWSPACE_COMMUNICATION_ENV: "live", META_WHATSAPP_ACCESS_TOKEN: "e2e-not-a-real-token",
  META_WHATSAPP_PHONE_NUMBER_ID: "e2e-phone-id", META_WHATSAPP_GRAPH_VERSION: "v23.0",
}, {
  messageId, recipient: "+919876500199",
  fetcher: async () => new Response(JSON.stringify({ error: { message: "Simulated Meta outage" } }), { status: 503, headers: { "content-type": "application/json" } }),
});
assert.equal(meta.status, "retry_pending", `Meta 503 must push receipt into retry: ${JSON.stringify(meta)}`);
assert.equal(sqlite.prepare("SELECT status FROM communication_outbox WHERE message_id=?").get(messageId).status, "retry_pending");

const bundle = await build({
  stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Page from './app/team/customer-experience/page.tsx';import Template from './app/team/customer-experience/template.tsx';createRoot(document.getElementById('root')).render(<Template><Page/></Template>);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, outfile: "bundle.js", format: "iife", jsx: "automatic",
  define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/bundle.css") { res.writeHead(200, { "content-type": "text/css" }); res.end(bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text || ""); return; }
    if (req.url === "/bundle.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles.find(file => file.path.endsWith(".js")).text); return; }
    if (!req.url.startsWith("/api/")) { res.writeHead(200, { "content-type": "text/html" }); res.end('<link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = `http://127.0.0.1:${server.address().port}${req.url}`;
    const request = new Request(url, { method: req.method, headers: { ...req.headers, "oai-authenticated-user-email": ACTOR }, ...(body ? { body } : {}) });
    const selectedRoute = req.url.startsWith("/api/whatsapp/conversation-control") ? controls : conversations;
    const result = await selectedRoute[req.method](request);
    res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) }));
  }
});

let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ extraHTTPHeaders: { "oai-authenticated-user-email": ACTOR } });
  await page.goto(`http://127.0.0.1:${server.address().port}/team/customer-experience`);
  const pending = page.getByText("Confirmed - Communication Pending", { exact: true });
  await pending.first().waitFor({ state: "visible", timeout: 10000 });
  assert.ok(await pending.count() >= 1, "CX inbox must surface the pending communication flag");
  await page.getByText(BOOKING, { exact: false }).first().waitFor({ state: "visible" });

  const dlq = await deadLetterOutbox(db, messageId, "meta_http_503_exhausted", { source: "playwright_e2e" });
  assert.equal(dlq.status, "dead_letter");
  await page.evaluate(() => window.dispatchEvent(new Event("pawspace:conversation-refresh")));
  const failed = page.getByText("Communication Failed", { exact: true });
  await failed.first().waitFor({ state: "visible", timeout: 10000 });

  console.log(JSON.stringify({ result: "passed", flow: "razorpay-capture-meta-503-cx-visibility", bookingId: BOOKING, threadId, messageId, retryState: "retry_pending", terminalState: "dead_letter", pendingFlagVisible: true, failedFlagVisible: true, externalMetaDelivery: false }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  sqlite.close();
}
