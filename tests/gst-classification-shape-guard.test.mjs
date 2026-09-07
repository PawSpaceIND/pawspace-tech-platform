/*
 * A tax classification whose components carry the wrong key used to take down invoicing with an
 * opaque database error, halfway through the write.
 *
 * lib/gst-accounting.ts reads tax_component_json as Array<{code,rate}> - the shape lib/gst-returns.ts
 * also reads when it builds GSTR-1. A row written as [{component:"CGST",rate:9}] therefore has a
 * working `rate` and an undefined `code`. The old guard only asserted `components.length`, so such a
 * row passed validation, the invoice and its lines were INSERTed, and the failure surfaced only when
 * finance_tax_ledger.component (NOT NULL) was bound undefined - as
 * "Provided value cannot be bound to SQLite parameter 5", with an invoice row already written and no
 * matching tax ledger rows.
 *
 * Found by tests/e2e-platform-scale.test.mjs, whose own fixture had made exactly this mistake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GST_SHAPE_DB__", "__GST_SHAPE_ENV__");

/* One database per test. Sharing one in-memory database across these tests made the non-vacuity
 * guard depend on its siblings: with the fix reverted, the refused invoices are written instead of
 * refused, and the leftover document-series and ledger rows then break the valid-invoice test too.
 * Isolating them keeps each verdict attributable to the code under test. */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args) => ({
    bind: (...bound) => stmt(sql, bound),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
  });
  const db = {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const st of list) out.push(await st.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  globalThis.__GST_SHAPE_DB__ = db;
  globalThis.__GST_SHAPE_ENV__ = {};
  return { sqlite, db };
}

const NOW = Date.UTC(2026, 8, 6);

/** Configure one entity fully, with `components` as the classification's tax_component_json. */
async function configure(gst, db, sqlite, entityId, components) {
  await gst.ensureGstAccountingTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO finance_entities VALUES (?,?,'IN','active','approver',?,?,?)")
    .run(entityId, `PawSpace ${entityId}`, NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_registrations VALUES (?,?,'KA','GSTIN','29AAAAA0000A1Z5','active','2026-04-01',NULL,'approver',?,?,?)")
    .run(`${entityId}-REG`, entityId, NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_policy_versions VALUES (?,?,1,'active','2026-04-01',NULL,?,'BOARD-1','approver',?,?,?)")
    .run(`${entityId}-POL`, entityId, JSON.stringify({ regime: "gst_in", roundingMode: "line" }), NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_classifications VALUES (?,?,'pet_grooming','SAC998729',?,'location_of_service','eligible',?)")
    .run(`${entityId}-CLS`, `${entityId}-POL`, JSON.stringify(components), NOW);
  sqlite.prepare("INSERT OR REPLACE INTO finance_document_series VALUES (?,?,'invoice',?,1,6,?,'active',?)")
    .run(`${entityId}-SER`, entityId, `${entityId}/26-27/`, `${entityId}-POL`, NOW);
}

const invoiceInput = (entityId, key) => ({
  entityId, issueDate: "2026-09-06", sourceEventKey: key, placeOfSupply: "KA",
  customerId: "CUS-1", sourceType: "booking", sourceId: "BK-1",
  registrationId: `${entityId}-REG`, currency: "INR",
  lines: [{ lineKey: "l1", description: "Full groom", serviceCode: "pet_grooming", amount: 1500, quantity: 1, taxableAmount: 1500 }],
});

test("GST-SHAPE: a classification component missing its code is refused with a governed error", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await configure(gst, db, sqlite, "E-BADKEY", [{ component: "CGST", rate: 9 }, { component: "SGST", rate: 9 }]);

  await assert.rejects(
    () => gst.issueInvoice(db, invoiceInput("E-BADKEY", "shape-badkey"), "test:finance"),
    (error) => {
      assert.match(String(error?.message), /tax_component_code:pet_grooming/,
        "must name the misconfigured component, not leak a database binding error");
      assert.doesNotMatch(String(error?.message), /bound to SQLite parameter/i,
        "the raw driver error must never reach the caller");
      return true;
    });

  // Fail CLOSED: nothing may be written when the classification is invalid. The old behaviour wrote
  // the invoice first and only then hit the ledger, leaving a row with no tax ledger entries.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE entity_id='E-BADKEY'").get().n, 0,
    "a refused invoice must leave no finance_invoices row");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_tax_ledger WHERE entity_id='E-BADKEY'").get().n, 0,
    "a refused invoice must leave no finance_tax_ledger rows");
});

test("GST-SHAPE-b: a component with a non-numeric rate is refused the same way", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await configure(gst, db, sqlite, "E-BADRATE", [{ code: "CGST", rate: "nine" }]);
  await assert.rejects(
    () => gst.issueInvoice(db, invoiceInput("E-BADRATE", "shape-badrate"), "test:finance"),
    (error) => {
      assert.match(String(error?.message), /tax_component_rate:pet_grooming/);
      return true;
    });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE entity_id='E-BADRATE'").get().n, 0);
});

test("GST-SHAPE-c: a correctly shaped classification still invoices, with its tax ledger", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await configure(gst, db, sqlite, "E-GOOD", [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]);

  const invoice = await gst.issueInvoice(db, invoiceInput("E-GOOD", "shape-good"), "test:finance");
  assert.ok(invoice?.id, "a valid classification must still produce an invoice");
  assert.equal(Number(invoice.subtotal), 1500);
  assert.equal(Number(invoice.tax_total), 270, "1500 at CGST 9 + SGST 9 is 270");

  const ledger = sqlite.prepare("SELECT component,amount FROM finance_tax_ledger WHERE entity_id='E-GOOD' ORDER BY component").all();
  assert.deepEqual(ledger.map((r) => r.component), ["CGST", "SGST"],
    "both components must reach the tax ledger under their canonical codes");
  assert.deepEqual(ledger.map((r) => Number(r.amount)), [135, 135]);
});
