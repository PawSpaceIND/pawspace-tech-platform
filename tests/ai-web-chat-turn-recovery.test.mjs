/**
 * Authenticated web chat: a retried message gets its reply, and a customer's first messages share one
 * conversation.
 *
 * Both behaviours were broken in the same function. A retry with the same idempotency key found its
 * message already stored and answered duplicatePrevented with no AI turn at all, so an attempt that
 * failed after storing the message could never be repaired - the V2 chat page re-sends the same key when
 * the customer presses Send again after a timeout, and got "This message was already received." instead
 * of an answer. And the open-thread lookup and insert were two separate steps, so two first messages
 * racing past the lookup each created a conversation of their own.
 *
 * Every case drives the real adapter, orchestrator and handoff modules over a real SQLite-backed D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, customerActor } from "./helpers/ai-harness.mjs";

installAiHooks();

const adapter = await import("../lib/ai-web-chat-adapter.ts");

async function world(customerId) {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, customerId, "Web Chat Customer", "9876500061");
  const actor = customerActor(sqlite, customerId);
  await adapter.ensureAiWebChatTables(db);
  const chat = (idempotencyKey, text = "What grooming services are available?") =>
    adapter.runAuthenticatedAiWebChat(db, { actor, customerId, text, idempotencyKey });
  const count = (table, where = "1=1", ...args) => sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;
  return { sqlite, db, chat, count };
}

test("a retry completes the AI turn that a failed first attempt left unanswered, and a replay never duplicates it", async () => {
  const w = await world("CUS-WEB-RETRY");
  const { ensureAiGovernance } = await import("../lib/ai-governance.ts");
  await ensureAiGovernance(w.db);
  w.sqlite.exec("CREATE TRIGGER fail_context BEFORE INSERT ON ai_context_snapshots BEGIN SELECT RAISE(ABORT,'injected context failure'); END");

  await assert.rejects(() => w.chat("web-retry-1"), /injected context failure/);
  assert.equal(w.count("communication_messages"), 1, "the failed attempt had already stored the customer's message");
  assert.equal(w.count("ai_conversation_turns"), 0);
  assert.equal(w.count("ai_web_chat_events"), 0);

  w.sqlite.exec("DROP TRIGGER fail_context");
  const retried = await w.chat("web-retry-1");
  assert.equal(retried.duplicatePrevented, true, "the message itself is not stored a second time");
  assert.ok(retried.ai?.turn?.output, "the retry carries the reply the first attempt never produced");
  assert.equal(retried.ai.duplicatePrevented, false, "the retry ran the released turn rather than reporting it as done");
  assert.equal(w.count("communication_messages"), 1);
  assert.equal(w.count("ai_conversation_turns"), 1);
  assert.equal(w.count("ai_web_chat_events", "event_type='authenticated_turn'"), 1, "the audit row the failed attempt never wrote is filled");

  const replay = await w.chat("web-retry-1");
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.ai.duplicatePrevented, true);
  assert.equal(String(replay.ai.turn.id), String(retried.ai.turn.id), "a replay returns the same turn");
  assert.equal(w.count("ai_conversation_turns"), 1, "and never runs a second one");
  assert.equal(w.count("ai_web_chat_events", "event_type='authenticated_turn'"), 1, "or writes a second audit row");
});

test("a replay in a conversation that has since been closed keeps the plain duplicate answer", async () => {
  const w = await world("CUS-WEB-CLOSED");
  const first = await w.chat("web-closed-1");
  assert.ok(first.ai?.turn);
  w.sqlite.prepare("UPDATE communication_threads SET status='closed' WHERE id=?").run(first.threadId);

  const replay = await w.chat("web-closed-1");
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.ai, undefined, "a closed conversation cannot take a turn, so none is attempted");
  assert.equal(w.count("ai_conversation_turns"), 1);
});

test("two first messages at once join one conversation instead of splitting it", async () => {
  const w = await world("CUS-WEB-RACE");
  const results = await Promise.allSettled([
    w.chat("web-race-a", "Hi, what grooming do you offer?"),
    w.chat("web-race-b", "And do you offer boarding?"),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"), "at least one message was answered");
  assert.equal(w.count("communication_threads", "customer_id='CUS-WEB-RACE'"), 1, "one customer, one open conversation");
  const threads = w.sqlite.prepare("SELECT DISTINCT thread_id FROM communication_messages WHERE customer_id='CUS-WEB-RACE'").all();
  assert.equal(threads.length, 1, "both messages are in the same conversation");
  assert.equal(w.count("communication_participants", "thread_id=?", threads[0].thread_id), 1, "the losing insert added no participant of its own");
});
