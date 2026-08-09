import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const lib=read("lib/gst-accounting.ts"),route=read("app/api/gst-accounting/route.ts"),page=read("app/team/finance/statutory/page.tsx"),backlog=read("docs/GST_ACCOUNTING_IMPLEMENTATION_BACKLOG.md");

test("gate 1 has effective-dated policy masters and fail-closed configuration",()=>{
 for(const marker of["finance_entities","tax_registrations","tax_policy_versions","tax_classifications","finance_document_series","ConfigurationRequired","active_tax_policy","active_tax_registration"])assert.match(lib,new RegExp(marker));
 assert.doesNotMatch(lib,/GST_RATE|CGST_RATE|SGST_RATE|IGST_RATE/);
});

test("gate 2 provides immutable idempotent invoice truth with allocated numbering",()=>{
 for(const marker of["finance_invoices","finance_invoice_lines","source_event_key TEXT NOT NULL UNIQUE","nextDocumentNumber","status TEXT NOT NULL DEFAULT 'issued'","tax_snapshot_json"])assert.match(lib,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
 assert.match(lib,/UPDATE finance_document_series SET next_number=next_number\+1/);
 assert.match(lib,/SELECT \* FROM finance_invoices WHERE source_event_key=\?/);
});

test("gate 3 uses linked bounded immutable credit and debit notes",()=>{
 assert.match(lib,/finance_adjustment_documents/);assert.match(lib,/credit_note_exceeds_invoice/);assert.match(lib,/invoice_id TEXT NOT NULL/);assert.match(lib,/kind==="credit_note"\?-tax:tax/);
});

test("gate 4 supports supplier duplicate protection, eligibility review and period lock",()=>{
 assert.match(lib,/finance_vendor_tax_reviews/);assert.match(lib,/UNIQUE\(vendor_id,supplier_invoice_number\)/);assert.match(lib,/review_status/);assert.match(lib,/period_locked/);
});

test("gate 5 creates tax ledger, review package, maker-checker and supersession",()=>{
 for(const marker of["finance_tax_ledger","finance_statutory_packages","variance_json","supersedes_id","maker_checker_required","approval_reference_required"])assert.match(lib,new RegExp(marker));
});

test("gate 6 uses versioned mapping, reproducible checksum and no live post",()=>{
 for(const marker of["accounting_mapping_versions","accounting_export_runs","SHA-256","checksum","productionPost:false","active_accounting_mapping"])assert.match(lib,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
 assert.match(route,/liveAccountingPostEnabled:false/);
});

test("gate 7 records FIN-01 close evidence without auto-verifying launch",()=>{
 assert.match(lib,/finance_close_evidence/);assert.match(lib,/variance_amount/);assert.doesNotMatch(lib,/UPDATE launch_readiness_items SET status='verified'/);
});

test("API is finance-governed, same-origin and explicitly non-production",()=>{
 assert.match(route,/requirePermission\(actor,"finance\.view"\)/);assert.match(route,/requirePermission\(actor,"finance\.manage"\)/);assert.match(route,/Cross-origin write blocked/);assert.match(route,/productionReady:false/);assert.match(route,/liveFilingEnabled:false/);
});

test("staff surface states configuration and production boundaries",()=>{
 assert.match(page,/PRODUCTION READY = FALSE/);assert.match(page,/configuration_required/);assert.match(page,/No production GST filing/);assert.match(page,/No live filing or production accounting post/);
});

test("implementation covers every documented backlog gate",()=>{
 for(let gate=1;gate<=7;gate++)assert.match(backlog,new RegExp(`Gate ${gate}`));
 for(const marker of["finance_entities","finance_invoices","finance_adjustment_documents","finance_vendor_tax_reviews","finance_tax_ledger","accounting_mapping_versions","finance_close_evidence"])assert.match(lib,new RegExp(marker));
});
