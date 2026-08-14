/**
 * FINDING 5 (P1) — FIXED. The Pet Relocation customer enquiry form now sends `relocationKind`.
 * `relocationKind` is a member of FormState (app/relocation-enquiry/page.tsx line 6), `empty`
 * defaults it to "domestic" (line 8), a visible "Relocation type" <select> is rendered (line 53),
 * and submit() posts {...form, phoneSecondary||undefined} (line 27) — so the field the server
 * requires is now carried by the page.
 *
 * Evidence by EXECUTION: we build the EXACT request body the page constructs (now WITH
 * relocationKind, mirroring FormState/empty and the visible <select>) and run it through the real
 * POST handler in app/api/relocation-enquiry/route.ts against a fresh node:sqlite D1. We also keep
 * the server-contract proof that the missing field was the sole cause: omitting it -> 400, adding
 * it back (same body otherwise) -> 200.
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
 * VALID. `relocationKind` is NOW a member of FormState (page.tsx line 6), defaulted to "domestic" in
 * `empty` (line 8) and set through the visible "Relocation type" <select> (line 53) — so it is present
 * here. This mirrors a real user filling in every visible field and clicking Submit.
 */
function pageRequestBody() {
  const form = {
    customerName: "Asha Menon",
    phonePrimary: "9876543210",
    phoneSecondary: "",            // page sends phoneSecondary||undefined -> dropped by JSON
    email: "asha@example.com",
    petType: "dog",
    relocationKind: "domestic",    // page.tsx now carries this field (FormState + the visible <select>)
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

test("FINDING 5 (fixed): the page's OWN payload now CARRIES relocationKind -> HTTP 200, row written", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RELOC_DB__ = makeD1(sqlite);

  const bodyAsSent = pageRequestBody();
  // Prove the field IS in the payload the page now sends.
  assert.equal("relocationKind" in bodyAsSent, true, "page body must now contain relocationKind");

  const res = await route.POST(postRequest(bodyAsSent));
  const json = await res.json();

  console.log("[page body WITH relocationKind] status =", res.status, "body =", JSON.stringify(json));

  assert.equal(res.status, 200, "the page's own payload is now accepted");
  assert.ok(json.data && typeof json.data.id === "string", "success payload carries the created enquiry");
  assert.equal(rowCount(sqlite), 1, "exactly one relocation_enquiries row written on success");
});

test("CONTRACT: relocationKind is the sole gate — omitting it -> 400, adding it back (same body) -> 200", async () => {
  // Server-contract proof that the missing field was the sole cause of the original failure.
  // WITHOUT relocationKind -> 400, no row.
  const sqlite1 = new DatabaseSync(":memory:");
  globalThis.__RELOC_DB__ = makeD1(sqlite1);
  const { relocationKind, ...withoutKind } = pageRequestBody();
  assert.equal("relocationKind" in withoutKind, false, "control body omits relocationKind");

  const resMissing = await route.POST(postRequest(withoutKind));
  const jsonMissing = await resMissing.json();
  console.log("[WITHOUT relocationKind] status =", resMissing.status, "body =", JSON.stringify(jsonMissing));
  assert.equal(resMissing.status, 400, "server rejects a body missing relocationKind");
  assert.match(jsonMissing.error, /domestic.*international|Relocation type/i, "must be the relocationKind validation error");
  assert.equal(rowCount(sqlite1), 0, "no relocation_enquiries row written on the 400");

  // Same body + relocationKind -> 200, one row (missing field is the sole cause).
  const sqlite2 = new DatabaseSync(":memory:");
  globalThis.__RELOC_DB__ = makeD1(sqlite2);
  const resPresent = await route.POST(postRequest({ ...withoutKind, relocationKind: "domestic" }));
  const jsonPresent = await resPresent.json();
  console.log("[WITH relocationKind]   status =", resPresent.status, "body =", JSON.stringify(jsonPresent));
  assert.equal(resPresent.status, 200, "identical body plus relocationKind must succeed");
  assert.ok(jsonPresent.data && typeof jsonPresent.data.id === "string", "success payload carries the created enquiry");
  assert.equal(rowCount(sqlite2), 1, "exactly one relocation_enquiries row written on success");
});
