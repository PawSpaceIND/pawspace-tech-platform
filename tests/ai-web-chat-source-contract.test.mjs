/*
 * The public AI chat surface, executed rather than described.
 *
 * This suite used to assert its four properties by regex-matching lib/ai-web-chat-adapter.ts,
 * app/api/ai-web-chat/route.ts and app/chat/page.tsx - it checked that the strings
 * `scope.includes("public")`, `customerDataAccess:false`, `requireCustomerOwnership` and
 * `Cross-origin AI web chat write blocked` APPEARED. /api/ai-web-chat GET is reachable by anyone on
 * the internet with no authentication at all, so "the filter is mentioned in the file" is the wrong
 * standard for it: the assertion that matters is that an internal knowledge row does NOT come back,
 * and no amount of source matching can show that.
 *
 * It now drives the real handlers against a real database. Converted to pay down the source-text
 * debt counted by tests/test-suite-executes-code.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CHAT_DB__", "__CHAT_ENV__");

const ORIGIN = "https://www.pawspace.test";
const OWNER = "chat.owner@pawspace.in";
const INTRUDER = "chat.intruder@pawspace.in";
const OWNER_CUSTOMER = "CUS-CHAT-OWNER";

function makeD1(sqlite) {
  const stmt = (sql, args) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
  });
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const PUBLIC_TITLE = "Dog grooming prices in Bengaluru";
const INTERNAL_TITLE = "Internal margin floors and escalation contacts";

let ctx;
async function world() {
  if (ctx) return ctx;
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CHAT_DB__ = db;
  globalThis.__CHAT_ENV__ = { APP_ENV: "staging" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const adapter = await import("../lib/ai-web-chat-adapter.ts");
  await adapter.ensureAiWebChatTables(db);
  const cfg = await import("../lib/ai-business-configuration.ts");
  for (const k of Object.keys(cfg)) if (/^ensure/.test(k)) await cfg[k](db);

  const now = Date.now();
  for (const [id, email] of [["USR-CHAT-OWNER", OWNER], ["USR-CHAT-INTRUDER", INTRUDER]]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?, 'customer','active',?,?)")
      .run(id, email, email, now, now);
  }

  /* Two knowledge rows, both ACTIVE, differing only in visibility scope. This is the whole point of
   * the conversion: the old test asserted the filter's source text existed. This asks the running
   * code whether the internal row comes back to an anonymous caller. */
  const kn = (id, title, scope) => sqlite.prepare(`INSERT INTO ai_knowledge_source_versions
      (id,source_key,version,status,title,source_type,content_text,visibility_scope_json,immutable_hash,created_by,created_at,updated_at)
      VALUES (?,?,1,'active',?,'manual',?,?,?, 'test',?,?)`)
    .run(id, id, title, `${title} - grooming price list and booking guidance for dogs`, JSON.stringify(scope), `hash-${id}`, now, now);
  kn("KN-PUBLIC", PUBLIC_TITLE, ["public"]);
  kn("KN-INTERNAL", INTERNAL_TITLE, ["internal"]);

  ctx = { sqlite, db, route: await import("../app/api/ai-web-chat/route.ts"), adapter };
  return ctx;
}

const getReq = (q) => new Request(`${ORIGIN}/api/ai-web-chat?q=${encodeURIComponent(q)}`);
const postReq = (body, headers = {}) => new Request(`${ORIGIN}/api/ai-web-chat`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});

test("CHAT-1: an anonymous caller gets public knowledge and NOT internal knowledge", async () => {
  const { route } = await world();
  const response = await route.GET(getReq("grooming"));
  assert.equal(response.status, 200, `public knowledge read returned ${response.status}`);
  const text = await response.text();
  assert.match(text, new RegExp(PUBLIC_TITLE.slice(0, 20)),
    "the public row did not come back - the filter is refusing everything, so the next assertion would pass vacuously");
  assert.doesNotMatch(text, /Internal margin floors/,
    "INTERNAL KNOWLEDGE LEAKED to an unauthenticated caller");
  assert.doesNotMatch(text, /escalation contacts/, "internal content leaked");
});

test("CHAT-2: the public surface reports no customer-data access and no tool execution", async () => {
  const { route } = await world();
  const body = await (await route.GET(getReq("grooming"))).json();
  assert.equal(body?.data?.customerDataAccess, false, "public chat claimed customer data access");
  assert.equal(body?.data?.toolExecution, false, "public chat claimed tool execution");
});

test("CHAT-3: an anonymous 'call me' message cannot make PawSpace dial anyone", async () => {
  /* The route's own comment: anonymous web leads stay capture-only so an internet user cannot type
   * somebody else's number and cause PawSpace to dial it. Driven here with a real callback phrase
   * from CALLBACK_PHRASES, in public mode, with a phone number that is not the caller's. */
  const { route, sqlite } = await world();
  const response = await route.POST(postReq({
    mode: "public", sessionKey: "SESS-ANON-1",
    message: "please call me back urgently", name: "Anon", phone: "9876500099",
  }));
  // 201 is correct here - a lead row is created. The status is not the property under test; what
  // matters is that no call was armed.
  assert.ok(response.status === 200 || response.status === 201,
    `public lead capture returned ${response.status}`);
  const body = await response.json();
  assert.equal(body?.data?.mode, "public");
  assert.notEqual(body?.data?.callbackAutomation, true, "an anonymous message armed callback automation");
  assert.ok(!("callback" in (body?.data ?? {})), "an anonymous message produced a callback object");
  const leads = sqlite.prepare("SELECT COUNT(*) n FROM ai_web_leads").get().n;
  assert.ok(leads >= 1, "the lead was not captured at all - capture-only must still capture");
});

test("CHAT-4: a cross-origin write is blocked before any handler work", async () => {
  const { route } = await world();
  const response = await route.POST(postReq(
    { mode: "public", sessionKey: "SESS-XO", message: "hello" },
    { origin: "https://evil.example" }));
  assert.equal(response.status, 403, `a cross-origin chat write returned ${response.status}`);
});

test("CHAT-5: an authenticated turn for someone else's customer id is refused", async () => {
  const { route } = await world();
  const response = await route.POST(postReq({
    mode: "authenticated", customerId: OWNER_CUSTOMER,
    message: "what is my next booking", idempotencyKey: "IDEM-INTRUDER-1",
  }, { "oai-authenticated-user-email": INTRUDER }));
  assert.notEqual(response.status, 200,
    "an intruder ran an authenticated chat turn against another customer's id");
});

test("CHAT-6: an authenticated turn requires a customer id, message and idempotency key", async () => {
  const { route } = await world();
  const response = await route.POST(postReq({
    mode: "authenticated", message: "hello",
  }, { "oai-authenticated-user-email": OWNER }));
  assert.equal(response.status, 400, `expected 400 for an incomplete turn, got ${response.status}`);
});
