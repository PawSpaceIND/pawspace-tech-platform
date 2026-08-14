/**
 * FINDING 5 (P1) — Pet Relocation customer enquiry form never sends `relocationKind`,
 * so the server (lib/relocation-enquiry.ts validate) rejects a fully-completed visible
 * form with HTTP 400 "domestic/international".
 *
 * Evidence by EXECUTION: we build the EXACT request body the page constructs
 * (app/relocation-enquiry/page.tsx submit(), line 27: JSON.stringify({...form,...}) —
 * every visible FormState field, WITHOUT relocationKind, because the field does not exist
 * on FormState/empty and is never added) and run it through the real POST handler in
 * app/api/relocation-enquiry/route.ts against a fresh node:sqlite D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RELOC_DB__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      sql, args,
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) { const info = sqlite.prepare(item.sql).run(...(item.args ?? [])); out.push({ success: true, meta: { changes: Number(info.changes) } }); }
      return out;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const route = await import("../app/api/relocation-enquiry/route.ts");

/**
 * The EXACT body app/relocation-enquiry/page.tsx builds: it is `{...form, phoneSecondary: ...||undefined}`
 * where `form` is FormState (page.tsx line 6/8). Every visible field the form collects is present and
 * VALID. `relocationKind` is absent because it is not a member of FormState and is never assigned —
 * this mirrors a real user filling in every visible field and clicking Submit.
 */
function pageRequestBody() {
  const form = {
    customerName: "Asha Menon",
    phonePrimary: "9876543210",
    phoneSecondary: "",            // page sends phoneSecondary||undefined -> dropped by JSON
    email: "asha@example.com",
    petType: "dog",
    pickupDate: "2026-09-01",
    pickupApproxTime: "10:00",
    pickupLocation: "Indiranagar, Bengaluru",
    dropLocation: "Bandra, Mumbai",
    expectedTravelDate: "2026-09-05",
  };
  // Exactly page.tsx line 27.
  return { ...form, phoneSecondary: form.phoneSecondary || undefined };
}

function postRequest(bodyObj) {
  return new Request("http://localhost/api/relocation-enquiry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

function rowCount(sqlite) {
  try { return Number(sqlite.prepare("SELECT COUNT(*) AS n FROM relocation_enquiries").get().n); }
  catch { return 0; } // table may not exist yet
}

test("FINDING 5: page body WITHOUT relocationKind -> HTTP 400, no row written", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RELOC_DB__ = makeD1(sqlite);

  const bodyAsSent = pageRequestBody();
  // Prove the field is genuinely never in the payload the page sends.
  assert.equal("relocationKind" in bodyAsSent, false, "page body must not contain relocationKind");

  const res = await route.POST(postRequest(bodyAsSent));
  const json = await res.json();

  console.log("[WITHOUT relocationKind] status =", res.status, "body =", JSON.stringify(json));

  assert.equal(res.status, 400, "server must reject the page's own payload with 400");
  assert.match(json.error, /domestic.*international|Relocation type/i, "must be the relocationKind validation error");
  assert.equal(rowCount(sqlite), 0, "no relocation_enquiries row may be written on the 400");
});

test("CONTROL: same body + relocationKind:'domestic' -> HTTP 200, row written (missing field is sole cause)", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RELOC_DB__ = makeD1(sqlite);

  const body = { ...pageRequestBody(), relocationKind: "domestic" };
  const res = await route.POST(postRequest(body));
  const json = await res.json();

  console.log("[WITH relocationKind]   status =", res.status, "body =", JSON.stringify(json));

  assert.equal(res.status, 200, "identical body plus relocationKind must succeed");
  assert.ok(json.data && typeof json.data.id === "string", "success payload carries the created enquiry");
  assert.equal(rowCount(sqlite), 1, "exactly one relocation_enquiries row written on success");
});
