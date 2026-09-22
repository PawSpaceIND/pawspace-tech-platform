/*
 * Owner decision 2026-09-22 (decision 4 of 10) — after a staff takeover on WEB CHAT, the customer is
 * asked in the thread for WhatsApp consent before anything moves; with no number, a CRM opt-out, or no
 * consent, the conversation stays in the thread and the customer is told a human will reply there; and
 * nothing may claim a WhatsApp message was sent when the WhatsApp keys are unset.
 *
 * The gap was wider than the consent question. There was no staff reply path for a thread on channel
 * 'chat' at all — queueWhatsAppHumanReply refuses any thread with no WhatsApp message ("Conversation is
 * not a WhatsApp thread"). So after a takeover the customer was told "I'm routing this conversation to a
 * PawSpace team member", the AI was paused, every further turn answered 409 "AI replies are paused while
 * the conversation is owned by staff" — and staff had no way to say anything back. The conversation
 * stopped, with the customer waiting.
 *
 * Every case drives the real module against a real database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CHAT_REPLY_DB__", "__CHAT_REPLY_ENV__");

const chat = await import("../lib/chat-human-reply.ts");

const STAFF = { email: "care.agent@pawspace.in", roleCode: "manager", permissions: ["communications.manage"], developmentPreview: false };
const CUSTOMER = "CUS-CHAT-1";
const THREAD = "THREAD-CHAT-1";
const WHATSAPP_ENV = { HAPTIK_API_KEY: "uat-key", HAPTIK_OUTBOUND_URL: "https://uat.haptikapi.com/outbound" };

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql), batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

/**
 * A web chat thread owned by staff. `phone` absent models a customer with no number on file;
 * `optOut`/`whatsappConsent` are the CRM contact preferences; `env` decides whether WhatsApp is
 * connected at all; `onWhatsApp` makes it a WhatsApp thread instead of a web chat one.
 */
async function thread({ phone = "9876500044", optOut = 0, whatsappConsent = 1, env = WHATSAPP_ENV, onWhatsApp = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CHAT_REPLY_DB__ = db;
  globalThis.__CHAT_REPLY_ENV__ = { ...env };

  await chat.ensureChatHumanReplyTables(db);
  const { ensureWhatsAppUatTables } = await import("../lib/whatsapp-uat-adapter.ts");
  await ensureWhatsAppUatTables(db);
  const { ensureCustomer360Tables } = await import("../lib/customer-360.ts");
  await ensureCustomer360Tables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,'customer_app','{}',1,1)").run(CUSTOMER, "blr", "Rhea Nair", phone || null);
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,whatsapp_consent,opt_out,updated_by,updated_at) VALUES (?,?,?,'seed',1)").run(CUSTOMER, whatsappConsent, optOut);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open',?,1,1)").run(THREAD, CUSTOMER, STAFF.email);
  if (onWhatsApp) {
    sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('WA-IN',?,?,'inbound','whatsapp','service','inbound','{}','delivered','limechat','wa-in','{}','customer',1,1)").run(THREAD, CUSTOMER);
  }

  /** The customer answering in the thread. Consent is transcribed from a real reply, never entered for them. */
  let replies = 0;
  const customerReplies = (body = "yes please") => {
    replies += 1;
    sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,'inbound','chat','service','customer_reply',?,'delivered','pawspace_web_chat',?,'{}','customer',?,?)")
      .run(`IN-${replies}`, THREAD, CUSTOMER, JSON.stringify({ text: body }), `in-${replies}`, Date.now() + 1000, Date.now() + 1000);
  };
  /** An approved WhatsApp template, without which no session can be opened with this customer. */
  const approveHandoverTemplate = () => sqlite.prepare("INSERT OR REPLACE INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?, 'approved','utility','en','test',1)").run(chat.CHAT_HANDOVER_TEMPLATE_KEY);
  const outbound = () => sqlite.prepare("SELECT template_key,channel,status,provider,payload_json,policy_json FROM communication_messages WHERE thread_id=? AND direction='outbound' ORDER BY created_at,id").all(THREAD);
  const said = () => outbound().map((row) => JSON.parse(row.payload_json).text);
  return { sqlite, db, outbound, said, customerReplies, approveHandoverTemplate };
}

const refusal = async (promise) => {
  try { await promise; return null; }
  catch (error) { return error instanceof Response ? { status: error.status, body: await error.json().catch(() => null) } : { thrown: error }; };
};

test("staff can finally reply on a web chat thread", async () => {
  const { db, outbound, said } = await thread();

  const reply = await chat.queueChatHumanReply(db, { actor: STAFF, threadId: THREAD, message: "Hello, I'm Asha from PawSpace. Let me sort this out.", clientRequestId: "req-00000001" });

  assert.equal(reply.channel, "chat");
  assert.equal(reply.externalDelivery, false, "nothing external is contacted");
  assert.ok(said().includes("Hello, I'm Asha from PawSpace. Let me sort this out."), "and the customer can read it in the thread they have open");
  assert.equal(outbound().find((row) => row.template_key === "chat_human_reply").provider, "pawspace_web_chat",
    "the provider is the web chat itself, so this can never be mistaken for a WhatsApp send");
});

test("a repeated reply does not post twice", async () => {
  const { db, said } = await thread();
  const send = () => chat.queueChatHumanReply(db, { actor: STAFF, threadId: THREAD, message: "On it.", clientRequestId: "req-00000002" });
  await send();
  const again = await send();
  assert.equal(again.duplicatePrevented, true);
  assert.equal(said().filter((line) => line === "On it.").length, 1);
});

test("the customer is ASKED in the thread before anything moves to WhatsApp", async () => {
  const { db, said } = await thread();

  const asked = await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });

  assert.equal(asked.asked, true);
  assert.equal(asked.inThreadConsent, "asked");
  assert.ok(said().some((line) => /continue this conversation on WhatsApp/.test(line)), "the question is put to the customer where they are");
  assert.ok(said().some((line) => /keep replying to you in this chat/.test(line)), "and does not make the chat sound like it is ending");

  // Until they answer, the move is refused.
  const blocked = await refusal(chat.moveChatThreadToWhatsApp(db, { actor: STAFF, threadId: THREAD }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body?.code, "consent_not_asked");
});

test("consent given moves the conversation, and the move actually queues a WhatsApp message", async () => {
  const granted = await thread();
  granted.approveHandoverTemplate();
  await chat.askWhatsAppMoveConsent(granted.db, { actor: STAFF, threadId: THREAD });
  granted.customerReplies("yes please");
  await chat.recordWhatsAppMoveConsent(granted.db, { threadId: THREAD, granted: true, actorId: STAFF.email });

  const moved = await chat.moveChatThreadToWhatsApp(granted.db, { actor: STAFF, threadId: THREAD });

  assert.equal(moved.moved, true);
  // `moved:true` on its own proves nothing: a function that did nothing at all could return it. What
  // makes this a move is a real WhatsApp message on the thread.
  assert.ok(moved.handoverMessageId, "the handover must have a message behind it");
  const whatsapp = granted.sqlite.prepare("SELECT id,channel,direction FROM communication_messages WHERE thread_id=? AND channel='whatsapp'").all(THREAD);
  assert.equal(whatsapp.length, 1, "exactly one WhatsApp message is queued for the handover");
  assert.equal(whatsapp[0].direction, "outbound");
  assert.equal(moved.externalDelivery, false, "queued, not delivered: dispatch stays the separate step it has always been");
  assert.ok(granted.said().some((line) => /moved this conversation to WhatsApp/.test(line)), "and the customer is told in the chat they are leaving");
});

test("consent refused keeps the conversation here", async () => {
  const declined = await thread();
  await chat.askWhatsAppMoveConsent(declined.db, { actor: STAFF, threadId: THREAD });
  declined.customerReplies("no thanks");
  await chat.recordWhatsAppMoveConsent(declined.db, { threadId: THREAD, granted: false, actorId: STAFF.email });

  const refused = await refusal(chat.moveChatThreadToWhatsApp(declined.db, { actor: STAFF, threadId: THREAD }));

  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "consent_declined");
  assert.ok(declined.said().some((line) => line.includes("will reply to you here in this chat")), "and the customer is told a human stays with them here");
  assert.equal(declined.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE thread_id=? AND channel='whatsapp'").get(THREAD).n, 0,
    "nothing is queued to WhatsApp for a customer who said no");
});

test("staff cannot record consent the customer never gave", async () => {
  // The in-thread question exists so the customer decides. Taking `granted` from the request body and
  // writing it down would have let staff record a yes that was never said.
  const { db, sqlite } = await thread();
  await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });

  const refused = await refusal(chat.recordWhatsAppMoveConsent(db, { threadId: THREAD, granted: true, actorId: STAFF.email }));

  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "customer_reply_required");
  assert.equal(sqlite.prepare("SELECT status FROM chat_whatsapp_move_consents WHERE thread_id=?").get(THREAD).status, "asked", "still merely asked");
});

test("no number, or a CRM opt-out, is not a question worth asking", async () => {
  for (const [label, options, code] of [
    ["no number on file", { phone: "" }, "no_phone_number"],
    ["opted out of PawSpace messaging", { optOut: 1 }, "crm_opt_out"],
  ]) {
    const { db, said } = await thread(options);
    const asked = await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });

    assert.equal(asked.asked, false, `${label}: offering a move that cannot happen is worse than not offering it`);
    assert.equal(asked.blockedBy, code);
    assert.ok(!said().some((line) => /Would you like us to continue/.test(line)), `${label}: the question is not put`);
    assert.ok(said().some((line) => line.includes("will reply to you here in this chat")), `${label}: the customer is told what will actually happen`);

    const blocked = await refusal(chat.moveChatThreadToWhatsApp(db, { actor: STAFF, threadId: THREAD }));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body?.code, code);
  }
});

test("with the WhatsApp keys unset, nothing claims a message was sent", async () => {
  // The decision's sharpest line. A queued-and-sent answer here would be a lie the customer never finds
  // out about, because no provider is ever going to carry it.
  const { db, said } = await thread({ env: {} });

  const asked = await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });
  assert.equal(asked.asked, false);
  assert.equal(asked.blockedBy, "whatsapp_not_connected");
  assert.equal(asked.providerConnected, false);

  const blocked = await refusal(chat.moveChatThreadToWhatsApp(db, { actor: STAFF, threadId: THREAD }));
  assert.equal(blocked.status, 503, "503, not a success and not a generic 409: the integration is absent");
  assert.equal(blocked.body?.code, "whatsapp_not_connected");
  assert.match(String(blocked.body?.error), /no message has been sent/);
  assert.ok(said().some((line) => line.includes("will reply to you here in this chat")));

  // And the staff reply path still works, which is the whole point of staying in the thread.
  await chat.queueChatHumanReply(db, { actor: STAFF, threadId: THREAD, message: "I can help with that right here.", clientRequestId: "req-00000003" });
  assert.ok(said().includes("I can help with that right here."));
});

test("a customer already on WhatsApp is neither asked to move there nor replied to in the wrong place", async () => {
  const { db, said } = await thread({ onWhatsApp: true });

  const asked = await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });
  assert.equal(asked.asked, false);
  assert.equal(asked.alreadyOnWhatsApp, true);
  assert.deepEqual(said(), [], "nothing is posted into a WhatsApp thread by the web chat path");

  const wrongPlace = await refusal(chat.queueChatHumanReply(db, { actor: STAFF, threadId: THREAD, message: "Hello?", clientRequestId: "req-00000004" }));
  assert.equal(wrongPlace.status, 409);
  assert.equal(wrongPlace.body?.code, "thread_is_whatsapp");
});

test("an answer cannot be recorded for a question that was never put", async () => {
  const { db } = await thread();
  const refused = await refusal(chat.recordWhatsAppMoveConsent(db, { threadId: THREAD, granted: true, actorId: STAFF.email }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "consent_not_asked");
});

test("a takeover on web chat asks the question by itself", async () => {
  // Behind a separate button this would be something staff have to know about. On the takeover it is
  // something that happens, which is what makes it testable on staging.
  const source = (await import("node:fs")).readFileSync(new URL("../app/api/ai-human-handoff/route.ts", import.meta.url), "utf8");
  assert.match(source, /askWhatsAppMoveConsent\(db,\{actor,threadId:body\.threadId\}\)/);
  assert.match(source, /body\.action==="take_over"\?await askWhatsAppMoveConsent/);
  assert.match(source, /\.catch\(\(\)=>null\)/, "best-effort: a posted message must not turn a committed takeover into an error");
});

test("with no approved template the move refuses, and says nothing was sent", async () => {
  // A customer who has only used web chat has no WhatsApp session, and WhatsApp will not let a business
  // open one with free text. No approved template means no move — reported, not worked around.
  const { db, sqlite } = await thread();
  await chat.askWhatsAppMoveConsent(db, { actor: STAFF, threadId: THREAD });
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('IN-T',?,?,'inbound','chat','service','customer_reply','{\"text\":\"yes\"}','delivered','pawspace_web_chat','in-t','{}','customer',?,?)")
    .run(THREAD, CUSTOMER, Date.now() + 1000, Date.now() + 1000);
  await chat.recordWhatsAppMoveConsent(db, { threadId: THREAD, granted: true, actorId: STAFF.email });

  const refused = await refusal(chat.moveChatThreadToWhatsApp(db, { actor: STAFF, threadId: THREAD }));

  assert.equal(refused.status, 503);
  assert.equal(refused.body?.code, "whatsapp_handover_not_queued");
  assert.match(String(refused.body?.error), /Nothing has been sent/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE thread_id=? AND channel='whatsapp'").get(THREAD).n, 0);
});
