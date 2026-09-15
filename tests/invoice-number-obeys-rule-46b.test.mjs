/*
 * GST rule 46(b): a tax invoice number is at most sixteen characters.
 *
 * Two modules mint them. lib/statutory-invoicing.ts has always asserted the rule on the number it
 * builds. lib/gst-accounting.ts - which is what lib/subscription-billing.ts invoices every renewal
 * through, and what /api/gst-accounting issues manual invoices through - did not assert it anywhere,
 * on either of its two numbering branches:
 *
 *  - the v2 FY/GSTIN series, whose SHAPE is validated by saveStatutorySeries but which
 *    resolveDocumentSeries also SEEDS from a legacy row that never passed through that validation;
 *  - the legacy finance_document_series counter, whose save_series writer accepted any prefix and
 *    any padding at all.
 *
 * And a shape check alone is not the rule: padStart only pads, so a series that is legal on the day
 * it is saved mints an illegal number once its serial outgrows its padding.
 *
 * The consequence was an invoice number GST rejects at filing, written to finance_invoices with the
 * tax ledger already posted against it - discovered at the return, not at issue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RULE46B_DB__", "__RULE46B_ENV__");

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
  globalThis.__RULE46B_DB__ = db;
  globalThis.__RULE46B_ENV__ = {};
  return { sqlite, db };
}

const NOW = Date.UTC(2026, 8, 6);

/** One fully configured entity, with the legacy invoice series written directly as `prefix`/`padding`. */
async function configure(gst, db, sqlite, entityId, { prefix, padding, nextNumber = 1 }) {
  await gst.ensureGstAccountingTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO finance_entities VALUES (?,?,'IN','active','approver',?,?,?)")
    .run(entityId, `PawSpace ${entityId}`, NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_registrations VALUES (?,?,'KA','GSTIN','29AAAAA0000A1Z5','active','2026-04-01',NULL,'approver',?,?,?)")
    .run(`${entityId}-REG`, entityId, NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_policy_versions VALUES (?,?,1,'active','2026-04-01',NULL,?,'BOARD-1','approver',?,?,?)")
    .run(`${entityId}-POL`, entityId, JSON.stringify({ regime: "gst_in", roundingMode: "line" }), NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_classifications VALUES (?,?,'pet_grooming','SAC998729',?,'location_of_service','eligible',?)")
    .run(`${entityId}-CLS`, `${entityId}-POL`, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]), NOW);
  sqlite.prepare("INSERT OR REPLACE INTO finance_document_series VALUES (?,?,'invoice',?,?,?,?,'active',?)")
    .run(`${entityId}-SER`, entityId, prefix, nextNumber, padding, `${entityId}-POL`, NOW);
}

const invoiceInput = (entityId, key) => ({
  entityId, issueDate: "2026-09-06", sourceEventKey: key, placeOfSupply: "KA",
  customerId: "CUS-1", sourceType: "booking", sourceId: "BK-1",
  registrationId: `${entityId}-REG`, currency: "INR",
  lines: [{ lineKey: "l1", description: "Full groom", serviceCode: "pet_grooming", amount: 1500, quantity: 1, taxableAmount: 1500 }],
});

test("GST-46B-1: a legacy series whose prefix is too long cannot issue an invoice", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  // "PAWSPACE/BLR/26-27/" is nineteen characters before a single digit of serial is appended. No
  // validation ever ran over finance_document_series, so a row like this could simply be present.
  await configure(gst, db, sqlite, "E-LONGPREFIX", { prefix: "PAWSPACE/BLR/26-27/", padding: 6 });

  await assert.rejects(
    () => gst.issueInvoice(db, invoiceInput("E-LONGPREFIX", "r46b-longprefix"), "test:finance"),
    (error) => {
      assert.match(String(error?.message), /invoice_number_exceeds_16_characters/,
        "the refusal must name the rule, not surface as a filing rejection months later");
      return true;
    });

  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE entity_id='E-LONGPREFIX'").get().n, 0,
    "a refused invoice must leave no finance_invoices row");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_tax_ledger WHERE entity_id='E-LONGPREFIX'").get().n, 0,
    "nor any tax ledger posting against a number that cannot be filed");
});

test("GST-46B-2: a serial that has outgrown its padding is refused, though the series shape is legal", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  // prefix 9 + padding 6 = 15, which validateDocumentSeries accepts. padStart only PADS, so serial
  // 12,345,678 renders as eight digits and the number is seventeen characters.
  await configure(gst, db, sqlite, "E-OVERFLOW", { prefix: "PS/26-27/", padding: 6, nextNumber: 12345678 });

  await assert.rejects(
    () => gst.issueInvoice(db, invoiceInput("E-OVERFLOW", "r46b-overflow"), "test:finance"),
    (error) => {
      assert.match(String(error?.message), /invoice_number_exceeds_16_characters/,
        "a shape check alone would have passed this series - the rule is about the NUMBER");
      return true;
    });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE entity_id='E-OVERFLOW'").get().n, 0);
});

test("GST-46B-3: a legal series still issues, and the number it mints obeys the rule", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await configure(gst, db, sqlite, "E-LEGAL", { prefix: "PS/26-27/", padding: 6 });

  const invoice = await gst.issueInvoice(db, invoiceInput("E-LEGAL", "r46b-legal"), "test:finance");
  assert.ok(invoice?.id, "the guard must narrow, not block invoicing");
  assert.equal(String(invoice.invoice_number), "PS/26-27/000001");
  assert.ok(String(invoice.invoice_number).length <= 16,
    `${invoice.invoice_number} is ${String(invoice.invoice_number).length} characters`);
  assert.equal(Number(invoice.tax_total), 270, "and the invoice is otherwise exactly what it was");
});

test("GST-46B-4: save_series refuses a shape that could only ever mint an illegal number", async () => {
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await gst.ensureGstAccountingTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO finance_entities VALUES (?,?,'IN','active','approver',?,?,?)")
    .run("E-SAVE", "PawSpace E-SAVE", NOW, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO tax_policy_versions VALUES (?,?,1,'active','2026-04-01',NULL,?,'BOARD-1','approver',?,?,?)")
    .run("E-SAVE-POL", "E-SAVE", JSON.stringify({ regime: "gst_in" }), NOW, NOW, NOW);

  const save = (prefix, padding) => gst.saveConfiguration(db, {
    action: "save_series", entityId: "E-SAVE", documentType: "invoice", prefix, padding,
    policyId: "E-SAVE-POL", reason: "UAT series configuration",
  }, "test:finance");

  // saveStatutorySeries, the v2 twin of this writer, has validated its series since it was written.
  await assert.rejects(() => save("PAWSPACE/BLR/26-27/", 6), /invoice_series_exceeds_16_characters/,
    "an operator must be told at configuration time, where they can still fix it");
  await assert.rejects(() => save("PS 26 27", 6), /invoice_series_invalid_characters/,
    "rule 46(b) also fixes the alphabet: alphanumerics, / and - only");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_document_series WHERE entity_id='E-SAVE'").get().n, 0,
    "a refused series must not be stored");

  await save("PS/26-27/", 6);
  assert.equal(sqlite.prepare("SELECT prefix FROM finance_document_series WHERE entity_id='E-SAVE'").get().prefix, "PS/26-27/",
    "and a legal series is still saved");
});

test("GST-46B-5: the v2 allocator refuses an illegal number without consuming a serial", async () => {
  const series = await import("../lib/document-series.ts");
  const { sqlite, db } = freshDb();
  sqlite.exec(series.DOCUMENT_SERIES_V2_DDL);
  sqlite.prepare("INSERT INTO finance_document_series_v2 (id,entity_id,gstin,document_type,financial_year,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('S1','E1','29AAAAA0000A1Z5','invoice','2026-27','PAWSPACE/BLR/26-27/',1,6,'POL','active',?)")
    .run(NOW);
  const row = sqlite.prepare("SELECT * FROM finance_document_series_v2 WHERE id='S1'").get();

  await assert.rejects(() => series.allocateDocumentNumber(db, row), /invoice_number_exceeds_16_characters/,
    "a v2 series SEEDED from an unvalidated legacy row reaches the allocator with that row's prefix");
  assert.equal(Number(sqlite.prepare("SELECT next_number FROM finance_document_series_v2 WHERE id='S1'").get().next_number), 1,
    "the counter must not move: a refused number that burns a serial leaves a gap in the series, which is its own filing problem");

  // Both halves: the allocator still allocates, and still advances, for a legal series.
  sqlite.prepare("UPDATE finance_document_series_v2 SET prefix='PS/26-27/' WHERE id='S1'").run();
  const legal = sqlite.prepare("SELECT * FROM finance_document_series_v2 WHERE id='S1'").get();
  assert.equal(await series.allocateDocumentNumber(db, legal), "PS/26-27/000001");
  assert.equal(Number(sqlite.prepare("SELECT next_number FROM finance_document_series_v2 WHERE id='S1'").get().next_number), 2);
});

test("GST-46B-7: the LEGACY counter branch is guarded too, not only the v2 series", async () => {
  /*
   * nextDocumentNumber has two branches and the tests above only exercise one: with a GSTIN on the
   * registration, resolveDocumentSeries seeds a v2 series and the v2 allocator does the minting. The
   * legacy branch is what runs for an installation whose invoices predate the registration being
   * recorded - exactly the case lib/subscription-billing.ts is called out for in that code comment -
   * and it builds its own number string, so it needs its own assertion. Drive it by leaving the
   * registration reference empty, which is the condition the branch actually tests.
   */
  const gst = await import("../lib/gst-accounting.ts");
  const { sqlite, db } = freshDb();
  await configure(gst, db, sqlite, "E-NOGSTIN", { prefix: "PAWSPACE/BLR/26-27/", padding: 6 });
  sqlite.prepare("UPDATE tax_registrations SET registration_reference='' WHERE entity_id='E-NOGSTIN'").run();

  await assert.rejects(
    () => gst.issueInvoice(db, invoiceInput("E-NOGSTIN", "r46b-legacy"), "test:finance"),
    /invoice_number_exceeds_16_characters/,
    "the legacy counter builds its number inline and must assert the rule on it");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE entity_id='E-NOGSTIN'").get().n, 0);

  // Both halves: the same branch still issues for a series that can mint a legal number.
  sqlite.prepare("UPDATE finance_document_series SET prefix='PS/26-27/' WHERE entity_id='E-NOGSTIN'").run();
  const invoice = await gst.issueInvoice(db, invoiceInput("E-NOGSTIN", "r46b-legacy-ok"), "test:finance");
  assert.ok(String(invoice?.invoice_number).startsWith("PS/26-27/"), `got ${invoice?.invoice_number}`);
  assert.ok(String(invoice.invoice_number).length <= 16);
});

test("GST-46B-6: the statutory path still refuses the same number, so the two modules agree", async () => {
  // lib/statutory-invoicing.ts asserted this before lib/gst-accounting.ts did. Pin that it still
  // does, and that both use the same message - one vocabulary for one rule.
  const { readFileSync } = await import("node:fs");
  const statutory = readFileSync(new URL("../lib/statutory-invoicing.ts", import.meta.url), "utf8");
  assert.match(statutory, /invoice_number_exceeds_16_characters/,
    "the statutory issuer must keep its own assertion - the shared helper is a second guard, not a replacement");
});
