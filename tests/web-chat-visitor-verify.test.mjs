/**
 * A web visitor books in the conversation. WATI's flow ends at a lead; here, once the bot has the visitor's
 * answers and number, a code is sent to that number and typing it in the chat signs the visitor in as the
 * customer (the same OTP exchange as the sign-in screen) and hands the enquiry to PawSpace AI to book. A
 * code that does not match is refused without leaving verification; any other reply steps out of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");
const route = await import("../app/api/ai-web-chat/route.ts");

const ORIGIN = "http://localhost", ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
const SIGNING_KEY = "uat-signing-key-0123456789abcdef0123456789abcdef", ASSERTION_SECRET = "uat-assertion-secret-0123456789abcdef0123456789abcdef";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (items) => { const r = []; for (const i of items) r.push(await i.run()); return r; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
async function world() {
  const sqlite = new DatabaseSync(":memory:"); const db = makeD1(sqlite);
  globalThis.__AI_WEB_CHAT_DB__ = db;
  // The sign-in route's sandbox OTP gate: UAT login on, sandbox identity, the UAT assertion secret.
  globalThis.__AI_WEB_CHAT_ENV__ = { PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_UAT_LOGIN: "on", PAWSPACE_IDENTITY_ENV: "sandbox", PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: ASSERTION_SECRET, PAWSPACE_UAT_SIGNING_KEY: SIGNING_KEY };
  await (await import("../lib/server-auth.ts")).ensureSecurityTables(db);
  await (await import("../lib/customer-account.ts")).ensureCustomerAccountTables(db);
  return { sqlite, db };
}
const post = (body) => new Request(ENDPOINT, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.44" }, body: JSON.stringify(body) });
const call = (body) => runWithWorkersDb(globalThis.__AI_WEB_CHAT_DB__, () => route.POST(post({ mode: "public", bot: true, ...body })));

/** A valid answer for any step the bot asks. */
function answerFor(reply) {
  const prompt = reply.text.toLowerCase();
  if ((reply.choices || []).length > 1) {
    // No active subscription (in WATI that enquiry is a team's, not a new booking); confirm the booking at the end.
    const ok = reply.choices.find((choice) => /^ok$/i.test(choice.label)), no = reply.choices.find((choice) => /^no\b/i.test(choice.label));
    return { choiceId: (ok || (prompt.startsWith("hi! do you currently have an active") && no) || reply.choices[0]).id };
  }
  if (prompt.includes("name")) return { message: "Asha Rao" };
  if (prompt.includes("mobile")) return { message: "98765 43210" };
  if (prompt.includes("email")) return { message: "asha@example.com" };
  if (prompt.includes("dd/mm")) return { message: "28/09" };
  return { message: "Indie, 2 years, Koramangala" };
}

async function completeGroomingFlow(sessionKey) {
  assert.equal((await call({ start: true, sessionKey })).status, 200);
  let response = await call({ sessionKey, choiceId: "grooming", message: "" }), body = await response.json();
  const trace = [];
  for (let step = 0; step < 14 && body.data.event !== "completed"; step++) {
    assert.equal(response.status, 200, JSON.stringify(body));
    const answer = answerFor(body.data.bot); trace.push(`${body.data.bot.text.slice(0, 60)} -> ${JSON.stringify(answer)}`);
    response = await call({ sessionKey, ...answer }); body = await response.json();
  }
  assert.equal(body.data.event, "completed", `the grooming flow completed:\n${trace.join("\n")}\n${body.data.bot?.text}`);
  return body;
}

test("a visitor who finishes the bot's questions is sent a code and, typing it, is signed in and booked by PawSpace AI", async () => {
  const { sqlite } = await world();
  const sessionKey = "visitor-verify-session-0001";
  const done = await completeGroomingFlow(sessionKey);
  assert.ok(done.data.verify?.sandboxCode, "a sandbox code was issued for the visitor's number");
  assert.equal(done.data.verify.phone, "9876543210");
  assert.match(done.data.bot.text, /confirm your number/);
  assert.equal(done.data.bot.inputHint, "Enter the 6-digit code");
  assert.equal(done.data.lead?.captured, true, "the lead still exists, as WATI would have it");

  // A wrong code is refused and the visitor stays in verification.
  const wrong = await (await call({ sessionKey, message: "000000" })).json();
  assert.match(wrong.data.bot.text, /didn't match/);

  const verified = await call({ sessionKey, message: done.data.verify.sandboxCode });
  const body = await verified.json();
  assert.equal(verified.status, 200, JSON.stringify(body));
  assert.equal(body.data.mode, "authenticated");
  assert.equal(body.data.verified, true);
  assert.match(String(verified.headers.get("set-cookie")), /pawspace_identity_session=/, "the response signs the visitor in");
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM canonical_customers WHERE primary_phone=?").get("9876543210").count, 1, "the visitor is now a customer");
  const customerId = body.data.customerId;
  assert.equal(sqlite.prepare("SELECT name FROM canonical_customers WHERE id=?").get(customerId).name, "Asha Rao");
  // The AI's booking turn ran on the customer's own thread and the transcript came back with the reply.
  const roles = body.data.transcript.messages.map((m) => m.role);
  assert.equal(roles[0], "customer");
  assert.match(body.data.transcript.messages[0].text, /book grooming/i);
  assert.ok(roles.includes("ai"), `PawSpace AI answered: ${JSON.stringify(roles)}`);
  assert.equal(body.data.transcript.threadId, body.data.threadId);
  // The code is single-use: the same one again no longer verifies and is not silently accepted.
  const again = await (await call({ sessionKey, message: done.data.verify.sandboxCode })).json();
  assert.equal(again.data.verified, undefined);
});

test("a visitor who answers something else steps out of verification and keeps the lead", async () => {
  await world();
  const sessionKey = "visitor-verify-session-0002";
  await completeGroomingFlow(sessionKey);
  const out = await (await call({ sessionKey, message: "no thanks" })).json();
  assert.match(out.data.bot.text, /with the PawSpace team/);
  const then = await (await call({ sessionKey, message: "do you groom cats?" })).json();
  assert.equal(then.data.verified, undefined);
  assert.ok(then.data.bot || then.data.ai, "the bot conversation continues normally");
});
