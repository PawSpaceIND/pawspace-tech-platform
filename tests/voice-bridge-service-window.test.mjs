import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// The service window masked calling is allowed in — EXECUTED, not matched.
//
// tests/voice-bridge-phase2-contract.test.mjs asserted this window by regex:
//
//   assert.match(governance, /ACTIVE_VOICE_SERVICE_STATES\s*=\s*\["assigned",\s*"en_route",\s*"in_progress"\]/)
//
// That assertion passed on a window that refused the normal case. Every vertical's
// accept path sets the booking to 'assigned' and the work order to 'accepted' in one
// batch, and resolveBridgeBooking prefers the work-order status — so a provider who
// had just accepted a job read as 'accepted', was absent from the list, and got a 409.
// Masked calling was closed for the whole window between acceptance and start, and the
// regex could not see it because it was checking the text of the list, not its effect.
//
// These run the real requestVoiceBridge against a real database.
// ---------------------------------------------------------------------------

installWorkersHooks("__VBRIDGE_WINDOW_DB__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const SCHEMA = [
  "CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL)",
  "CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT)",
  "CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,phone TEXT)",
  "CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL)",
];

const PROVIDER_ACTOR = {
  email: "walker@pawspace.in", name: "Walker", roleCode: "service_provider", permissions: [],
  developmentPreview: false, identitySource: "partner_otp", principalType: "email",
  principalKey: "walker@pawspace.in",
};

async function world({ workOrderStatus, bookingStatus = "assigned" }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__VBRIDGE_WINDOW_DB__ = db;
  for (const sql of SCHEMA) sqlite.exec(sql);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUST-1','PRV-1',?)").run(bookingStatus);
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUST-1','+919000000001')").run();
  sqlite.prepare("INSERT INTO canonical_providers VALUES ('PRV-1','+919000000002')").run();
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('BK-1','PRV-1',?)").run(workOrderStatus);

  const bridge = await import("../lib/voice-bridge-governance.ts");
  // Ownership is real, not bypassed: the provider is bound to PRV-1 through identity_bindings, so a
  // pass here is the window opening, never a permission shortcut.
  const { ensureIdentityBindingTables } = await import("../lib/identity-binding.ts");
  await ensureIdentityBindingTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO identity_bindings (id,identity_source,principal_type,principal_key,subject_type,subject_id,status,verification_state,created_by,updated_by,created_at,updated_at) VALUES ('IB-1','partner_otp','email','walker@pawspace.in','provider','PRV-1','active','verified','seed','seed',?,?)").run(now, now);
  return { sqlite, db, bridge };
}

/* The voice env is left unconfigured on purpose. resolveBridgeBooking runs the window check BEFORE the
 * dial, so the two outcomes are cleanly separable without ever contacting Exotel:
 *   window CLOSED -> 409 "available only during an active service window"
 *   window OPEN   -> the request reaches resolveVoiceCallGate and stops at 503 (voice disabled)
 * A 503 is therefore proof the window admitted the caller. */
async function attempt(bridge, db, key = `idem-${crypto.randomUUID()}`) {
  try {
    await bridge.requestVoiceBridge(db, {}, PROVIDER_ACTOR, { bookingId: "BK-1", idempotencyKey: key });
    return { status: 200, body: "" };
  } catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.clone().text() };
    throw error;
  }
}

// --- VBW-01 ---------------------------------------------------------------
// The case the old regex assertion allowed through broken.
test("VBW-01: a provider who has ACCEPTED the job can open a masked call", async () => {
  const { db, bridge } = await world({ workOrderStatus: "accepted" });
  const result = await attempt(bridge, db);
  assert.notEqual(result.status, 409, `accepted must not be refused as outside the service window: ${result.body}`);
  assert.equal(result.status, 503, "the request should reach the voice gate and stop there, unconfigured");
});

// --- VBW-02 ---------------------------------------------------------------
test("VBW-02: assigned and in_progress remain open", async () => {
  for (const status of ["assigned", "in_progress"]) {
    const { db, bridge } = await world({ workOrderStatus: status });
    const result = await attempt(bridge, db);
    assert.equal(result.status, 503, `${status} should reach the voice gate, got ${result.status}: ${result.body}`);
  }
});

// --- VBW-03 ---------------------------------------------------------------
// The window must still close. Without this, VBW-01 could be satisfied by removing the check entirely.
test("VBW-03: terminal and recovery states are still refused as outside the window", async () => {
  for (const status of ["completed", "cancelled", "recovery_pending", "reassignment_needed"]) {
    const { db, bridge } = await world({ workOrderStatus: status, bookingStatus: status });
    const result = await attempt(bridge, db);
    assert.equal(result.status, 409, `${status} must be refused, got ${result.status}`);
    assert.match(result.body, /active service window/);
  }
});

// --- VBW-04 ---------------------------------------------------------------
// A drift guard, and the only assertion here that reads source rather than running it: a state can be
// listed as "active" and admit nothing, which is what en_route did. This cannot be executed — it is a
// claim about the rest of the codebase — so it complements the executed tests above rather than
// standing in for them.
test("VBW-04: every state in the window is one some lifecycle actually writes", async () => {
  const { ACTIVE_VOICE_SERVICE_STATES } = await import("../lib/voice-bridge-governance.ts");
  const { readdir } = await import("node:fs/promises");
  const sources = [];
  for (const dir of ["lib", "app"]) {
    const walk = async (path) => {
      for (const entry of await readdir(new URL(`../${path}/`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(`${path}/${entry.name}`);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) sources.push(await readFile(new URL(`../${path}/${entry.name}`, import.meta.url), "utf8"));
      }
    };
    await walk(dir);
  }
  const corpus = sources.join("\n");
  const dead = ACTIVE_VOICE_SERVICE_STATES.filter((state) =>
    !new RegExp(`status='${state}'|status="${state}"`).test(corpus));
  assert.deepEqual(dead, [], "these states are in the masked-call window but nothing ever sets them");
});
