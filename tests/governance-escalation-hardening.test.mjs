import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Close-out for the comms/identity/governance audit: the residual gaps PR #137 did not cover.
// "cloudflare:workers" resolves to a stub whose env.DB is the per-test SQLite D1 shim and whose
// other keys (FOUNDER_EMAIL) read a mutable test env, so the REAL routes/gateway run unmodified.
const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__GOV_DB__:(globalThis.__GOV_ENV__??{})[k]});";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb() {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__GOV_DB__ = makeD1(sqlite);
  globalThis.__GOV_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };
}

const governanceRoute = await import("../app/api/platform-governance/route.ts");
const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const { getConversation, recordInboundMessage } = await import("../lib/conversation-governance.ts");
const { enqueueCommunication, ensureCommunicationTables, failOutboxAttempt } = await import("../lib/communication-engine.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
// Real header-based staff identity on a non-local host (no preview shortcut).
const callAs = async (bodyOrQuery, email, method = "POST") => {
  const url = "https://app.pawspace.test/api/platform-governance";
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? governanceRoute.GET(request) : governanceRoute.POST(request));
  return { status: response.status, body: await parseBody(response) };
};
const NOW = Date.now();
async function seedUsers() {
  // The route's own ensureTables creates app_users/role_definitions; trigger it via founder GET.
  const boot = await callAs(null, "founder@pawspace.test", "GET");
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-admin','admin@pawspace.test','Admin','admin','active',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-target','asha@pawspace.test','Asha','associate','active',?,?)").run(NOW, NOW);
}
const gatewayRequest = (email, path = "/api/customer-360") => new Request(`https://app.pawspace.test${path}`, { headers: { "oai-authenticated-user-email": email } });
const gatewayEnv = () => ({ DB: globalThis.__GOV_DB__, FOUNDER_EMAIL: "founder@pawspace.test" });

// ---- 1. REGRESSION: privilege escalation to founder via update_user ---------------------------

test("REGRESSION app/api/platform-governance/route.ts: update_user can no longer promote an account to founder (create_user was guarded; update_user was the open escalation path)", async () => {
  freshDb(); await seedUsers();
  // admin has users.manage - exactly the actor the escalation was open to
  const promote = await callAs({ action: "update_user", id: "u-target", roleCode: "founder", status: "active" }, "admin@pawspace.test");
  assert.equal(promote.status, 400, JSON.stringify(promote.body));
  assert.match(String(promote.body.error), /Founder is protected/);
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE id='u-target'").get().role_code, "associate", "the target's role must be untouched");
  // Both doors closed: create_user keeps its original guard
  const create = await callAs({ action: "create_user", email: "new@pawspace.test", name: "New User", roleCode: "founder" }, "admin@pawspace.test");
  assert.equal(create.status, 400);
  // Self-promotion is equally dead
  const self = await callAs({ action: "update_user", id: "u-admin", roleCode: "founder", status: "active" }, "admin@pawspace.test");
  assert.equal(self.status, 400);
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE id='u-admin'").get().role_code, "admin");
  // Legitimate role changes still work and are audited
  const legit = await callAs({ action: "update_user", id: "u-target", roleCode: "manager", status: "active" }, "admin@pawspace.test");
  assert.equal(legit.status, 200, JSON.stringify(legit.body));
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE id='u-target'").get().role_code, "manager");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='update_user'").get().n, 1);
});

// ---- 2. Real-execution: role-permission escalation requires roles.manage -----------------------

test("real execution: save_role is refused for a users.manage-only admin; a founder's role change re-scopes the gateway on the very next request", async () => {
  freshDb(); await seedUsers();
  // admin (users.manage, NO roles.manage) cannot rewrite role permissions
  const denied = await callAs({ action: "save_role", code: "associate", permissions: ["*"] }, "admin@pawspace.test");
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  // The founder role itself can never be rewritten
  const founderRole = await callAs({ action: "save_role", code: "founder", permissions: [] }, "founder@pawspace.test");
  assert.equal(founderRole.status, 400);
  // Before the change: an associate passes the customers.view gate through the REAL gateway
  const before = await authorizeApiRequest(gatewayRequest("asha@pawspace.test"), gatewayEnv());
  assert.ok(!(before instanceof Response), "associate holds customers.view before the role change");
  // Founder removes customers.view from the associate role; bogus permissions are filtered out
  const saved = await callAs({ action: "save_role", code: "associate", permissions: ["dashboard.view", "bookings.view", "everything.manage"] }, "founder@pawspace.test");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = JSON.parse(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code='associate'").get().permissions_json);
  assert.ok(!stored.includes("everything.manage"), "unknown permissions never enter a role");
  assert.deepEqual(stored.sort(), ["bookings.view", "dashboard.view"]);
  // ...and the change bites on the very next gateway request
  const after = await authorizeApiRequest(gatewayRequest("asha@pawspace.test"), gatewayEnv());
  assert.ok(after instanceof Response, "customers.view was revoked, the gateway must now refuse");
  assert.equal(after.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='save_role'").get().n, 1, "the role change is audited");
});

// ---- 3. Conversation scope masking (uncovered by #137) -----------------------------------------

test("real execution: non-staff conversation scopes strip phone numbers and internal notes from message payloads", async () => {
  freshDb();
  const db = globalThis.__GOV_DB__;
  await ensureCommunicationTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES ('TH1','cus_1','open',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES ('P1','TH1','customer','cus_1','Asha','member',?)").run(now);
  sqlite.prepare("INSERT INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES ('P2','TH1','provider','prov_1','Kiran','member',?)").run(now);
  await recordInboundMessage(db, { threadId: "TH1", customerId: "cus_1", channel: "whatsapp", payload: { text: "Where is my groomer?", customerPhone: "9876543210", providerPhone: "9123456780", internalNote: "VIP - escalate fast" }, provider: "sandbox", providerReference: "ref-1", eventId: "ev-1", createdBy: "test" });
  const staff = await getConversation(db, "TH1", "staff");
  assert.equal(staff.messages[0].payload.customerPhone, "9876543210", "staff scope keeps the full payload");
  assert.equal(staff.participants.length, 2);
  for (const scope of ["provider", "customer"]) {
    const view = await getConversation(db, "TH1", scope);
    const payload = view.messages[0].payload;
    assert.equal(payload.customerPhone, undefined, `${scope} scope must never see the customer phone`);
    assert.equal(payload.providerPhone, undefined, `${scope} scope must never see the provider phone`);
    assert.equal(payload.internalNote, undefined, `${scope} scope must never see internal notes`);
    assert.equal(payload.text, "Where is my groomer?", "the actual message text still flows");
    assert.ok(!JSON.stringify(view).includes("9876543210"), `no raw customer number anywhere in the ${scope} response`);
    assert.equal(view.assignments.length, 0, "assignment history is staff-only");
  }
});

// ---- 4. Outbox dead-letter exactly once (uncovered by #137) -------------------------------------

test("real execution: repeated delivery failures back off, dead-letter EXACTLY once at max attempts, and stay dead", async () => {
  freshDb();
  const db = globalThis.__GOV_DB__;
  // Exact DDL copied verbatim from app/api/canonical-bookings/route.ts (consent lookup source).
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('cus_1','blr','Asha','+919876543210',?,?)").run(NOW, NOW);
  const queued = await enqueueCommunication(db, { customerId: "cus_1", cityId: "blr", channel: "whatsapp", purpose: "transactional", idempotencyKey: "dl-1", templateKey: "booking_update", payload: { text: "Your groomer is on the way" }, createdBy: "test", bookingId: "B1" });
  assert.equal(queued.status, "queued", JSON.stringify(queued));
  const maxAttempts = Number(sqlite.prepare("SELECT max_attempts FROM communication_outbox WHERE message_id=?").get(queued.messageId).max_attempts);
  assert.ok(maxAttempts >= 2, "policy supplies a real retry budget");
  let last;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    last = await failOutboxAttempt(db, queued.messageId, `provider timeout ${attempt}`);
    assert.equal(last.status, "retry_pending", `attempt ${attempt} of ${maxAttempts} still retries`);
    assert.equal(last.attempts, attempt);
    assert.ok(last.nextAttemptAt > Date.now(), "backoff schedules a future retry");
  }
  const dead = await failOutboxAttempt(db, queued.messageId, "provider timeout final");
  assert.equal(dead.status, "dead_letter");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_dead_letters").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM communication_messages WHERE id=?").get(queued.messageId).status, "dead_letter");
  // A straggler failure after dead-lettering never creates a second dead letter
  const again = await failOutboxAttempt(db, queued.messageId, "late straggler failure");
  assert.equal(again.status, "dead_letter");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_dead_letters").get().n, 1, "dead-letter is exactly-once per message");
});

// ---- 5. Contracts --------------------------------------------------------------------------------

test("contract: both founder guards pinned in the route, escalation split pinned in the gateway", () => {
  const source = fs.readFileSync(new URL("../app/api/platform-governance/route.ts", import.meta.url), "utf8");
  const guards = source.match(/Founder is protected and cannot be assigned here/g) || [];
  assert.equal(guards.length, 2, "create_user AND update_user must both refuse founder assignment");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /body\.action==="save_role"\?"roles\.manage":"users\.manage"/, "role rewrites stay behind roles.manage at the gateway too");
});
