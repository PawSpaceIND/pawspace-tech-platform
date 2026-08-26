/**
 * WAVE 3 TIER A - adversarial verification of W2-B4-M-R04. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "the anonymous AI web-chat lead capture does NOT feed the automated
 * outbound voice dialler - ai_web_leads is a terminal table with no consumer".
 *
 * Why it matters: /api/ai-web-chat is deliberately reachable with NO identity of any kind. If a phone
 * number typed into an anonymous chat box could reach the auto-dialler, anybody on the internet could
 * make PawSpace cold-call a stranger - a consent and TRAI problem, not just a bug.
 *
 * The claim is half behavioural and half structural, and the structural half is the one that rots: a
 * future sweep that starts reading ai_web_leads would silently connect the two. So this pins BOTH, and
 * the containment guard names every consumer of the table rather than trusting today's answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_CHAT_DB__", "__W3A_CHAT_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function chatWorld() {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__W3A_CHAT_DB__ = makeD1(sqlite);
  globalThis.__W3A_CHAT_ENV__ = {};
  return globalThis.__W3A_CHAT_DB__;
}

const CAMPAIGNS = ["new_lead_followup", "reactivation", "subscription_pitch"];
const VICTIM_PHONE = "+919812345678";

async function anonymousChat(body) {
  const route = await import("../app/api/ai-web-chat/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/ai-web-chat", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

const count = (table) => { try { return Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c); } catch { return 0; } };

test("MR04-01: an anonymous chat lead is captured but reaches NO dialler audience", async () => {
  const db = chatWorld();
  const res = await anonymousChat({ mode: "public", sessionKey: "sess-w3a-1", message: "call me about grooming", name: "Anon", phone: VICTIM_PHONE, email: "anon@example.test" });
  assert.ok(res.status >= 200 && res.status < 300, `the public capture path stays open: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.data?.lead?.captured, true, "the lead is captured");

  const { buildOutboundAudience } = await import("../lib/haptik-outbound-governance.ts");
  for (const campaign of CAMPAIGNS) {
    const audience = await buildOutboundAudience(db, { campaign });
    assert.deepEqual(audience, [], `${campaign} must not pick up an anonymous chat lead`);
  }
});

test("MR04-02: the anonymous capture writes no CRM lead row at all", async () => {
  chatWorld();
  await anonymousChat({ mode: "public", sessionKey: "sess-w3a-2", message: "call me", name: "Anon", phone: VICTIM_PHONE });
  assert.equal(count("lead_work_items"), 0, "no lead work item - that is what the dialler reads");
  assert.equal(count("crm_contacts"), 0, "and no CRM contact");
});

test("MR04-03: repeat submissions on one session key cannot flood the table", async () => {
  chatWorld();
  for (let i = 0; i < 5; i++) {
    await anonymousChat({ mode: "public", sessionKey: "sess-w3a-3", message: `attempt ${i}`, name: "Anon", phone: VICTIM_PHONE });
  }
  assert.equal(count("ai_web_leads"), 1, "the per-sessionKey upsert bounds one key to a single row");
});

test("MR04-04 (non-vacuity): a REAL CRM lead IS picked up by the same dialler audience", async () => {
  // Without this, MR04-01 would pass on a dialler that returns [] for everything - which would hide the
  // opposite bug rather than prove containment.
  const db = chatWorld();
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,created_at,updated_at) VALUES ('CUS-REAL','Real Lead','+919800000077','real@example.in',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-REAL','CUS-REAL','website','grooming','Unassigned','Manager','active',?,?,?,?,?)").run(now, now, now, now, now);

  const { buildOutboundAudience } = await import("../lib/haptik-outbound-governance.ts");
  const audience = await buildOutboundAudience(db, { campaign: "new_lead_followup" });
  assert.equal(audience.length, 1, `a genuine CRM lead must be picked up, got ${JSON.stringify(audience)}`);
  assert.equal(audience[0].contactId, "CUS-REAL");
});

// -----------------------------------------------------------------------------------------------
// The structural half: containment, asserted rather than assumed.
// -----------------------------------------------------------------------------------------------

test("MR04-05: ai_web_leads has exactly ONE module touching it, and it is the adapter", async () => {
  // The behavioural cases above are true of today's code. This is what stops a future sweep from
  // quietly wiring the anonymous table into an outbound path and still passing them.
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      if (source.includes("ai_web_leads")) found.push(path);
    }
  };
  for (const root of ["lib", "app"]) await walk(root);
  assert.deepEqual(found, ["lib/ai-web-chat-adapter.ts"],
    "an anonymous, unauthenticated lead table must stay terminal: any new reader is a path from a stranger's typed phone number to an outbound call");
});

test("MR04-06: the dialler's audience queries read CRM tables, never the anonymous chat table", async () => {
  const source = await readFile(new URL("../lib/haptik-outbound-governance.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ai_web_leads/, "the outbound audience builder must not read the anonymous capture table");
  assert.match(source, /lead_work_items/, "and must read the CRM lead table - if this stops matching, the detector broke, not the code");
});
