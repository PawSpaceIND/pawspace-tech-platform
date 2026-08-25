import assert from "node:assert/strict";
import{readFile}from"node:fs/promises";
import test from"node:test";

const root=new URL("../",import.meta.url);
const read=path=>readFile(new URL(path,root),"utf8");

test("GST API routes filing-sensitive actions through closeout guards",async()=>{
 const route=await read("app/api/gst-accounting/route.ts");
 assert.match(route,/issue_invoice"\)data=await issueInvoiceSafe/);
 assert.match(route,/generate_statutory_package"\)data=await generateStatutoryPackageSafe/);
 assert.match(route,/generate_annual_return"\)data=await generateAnnualReturnSafe/);
 assert.match(route,/approve_annual_return"\)data=await approveAnnualReturnSafe/);
 assert.match(route,/generate_accounting_export"\)data=await generateAccountingExportSafe/);
});

test("repeated invoice lines use line identity in tax event keys",async()=>{
 const[source,wrapper]=await Promise.all([read("lib/gst-accounting.ts"),read("lib/finance-filing-closeout.ts")]);
 assert.match(source,/lineKey:text\(line\.lineKey\)/);
 assert.match(source,/\$\{eventKey\}:\$\{text\(s\.lineKey\)\}:\$\{c\.code\}/);
 assert.doesNotMatch(wrapper,/DELETE FROM finance_tax_ledger/);
});

test("ITC calculations are legal-entity scoped",async()=>{
 const source=await read("lib/finance-filing-closeout.ts");
 const matches=source.match(/b\.entity_id=\?/g)??[];
 assert.ok(matches.length>=2,"monthly and annual ITC must both filter by bill entity");
});

test("annual approval fails closed when monthly reconciliation is incomplete",async()=>{
 const source=await read("lib/finance-filing-closeout.ts");
 assert.match(source,/reconciliation\.reconciled!==true/);
 assert.match(source,/annual_reconciliation_not_clean/);
});

test("accounting export contains only posted journals for the requested entity",async()=>{
 const source=await read("lib/finance-filing-closeout.ts");
 assert.match(source,/WHERE entity_id=\? AND period_code=\? AND posted=1/);
});

test("finance mutations use authenticated actors and atomically exclude locked periods",async()=>{
 const route=await read("app/api/finance-control/route.ts");
 assert.match(route,/resolveActor\(request\)/);
 assert.match(route,/requirePermission\(actor,"finance\.manage"\)/);
 assert.doesNotMatch(route,/actorRole/);
 assert.doesNotMatch(route,/locked_by.*finance_uat/);
 assert.match(route,/const eligible=`[^`]*NOT EXISTS \(SELECT 1 FROM finance_close_periods WHERE period_code=\? AND status='locked'\)`/s);
 assert.match(route,/INSERT INTO finance_journal_posting_claims[\s\S]*WHERE \$\{eligible\}/);
 assert.match(route,/UPDATE \$\{input\.table\} SET status='approved'[\s\S]*claim_token=\?/);
});
