/* Statutory document numbering, in ONE place.
 *
 * There are two document-series tables and, until [R3-D/F2], two modules that disagreed about which
 * one is real:
 *
 *   finance_document_series      (legacy)  entity + document_type. Cannot express a financial year and
 *                                         cannot express a GSTIN, so it cannot roll over at 1 April and
 *                                         cannot keep two registrations apart.
 *   finance_document_series_v2             entity + GSTIN + document_type + financial year - the shape
 *                                         rule 46(b) actually requires (a serial unique for the FY,
 *                                         per place of business).
 *
 * lib/statutory-invoicing.ts allocates from v2; lib/gst-accounting.ts allocated from the legacy table.
 * The only control on /team/finance/statutory writes v2. So "Save invoice series" wrote a table
 * issueAdjustment never read, and a credit note was unissuable from the product: it refused with
 * 409 configuration_required credit_note_series no matter how many times the operator saved the series
 * the screen offered. Worse, an invoice number could be allocated from BOTH tables at once - two
 * different serial counters for one statutory series.
 *
 * v2 wins, because it is the only shape that can be correct, and the legacy row is treated as the
 * migration source: the first allocation for an (entity, GSTIN, document type, FY) seeds v2 from the
 * legacy counter, so an installation configured before v2 existed keeps numbering where it left off and
 * nothing has to be re-entered. Neither caller decides this any more - both ask here.
 *
 * Deliberately depends on NOTHING: lib/statutory-invoicing.ts imports lib/gst-accounting.ts, so a
 * helper both of them can use cannot import either. It therefore returns null for "not configured"
 * and lets each caller raise its own governed ConfigurationRequired.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v??0);
const id=(p:string)=>`${p}_${crypto.randomUUID().slice(0,16)}`;

/** The v2 series table. Exported as DDL so every ensure() creates exactly the same table - a second,
 *  slightly different CREATE TABLE IF NOT EXISTS is a no-op against whichever ran first, which is how
 *  a column goes missing in one deployment and not another. */
export const DOCUMENT_SERIES_V2_DDL="CREATE TABLE IF NOT EXISTS finance_document_series_v2 (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,gstin TEXT NOT NULL,document_type TEXT NOT NULL,financial_year TEXT NOT NULL,prefix TEXT NOT NULL,next_number INTEGER NOT NULL DEFAULT 1,padding INTEGER NOT NULL DEFAULT 6,policy_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',updated_at INTEGER NOT NULL,UNIQUE(entity_id,gstin,document_type,financial_year))";

/** Indian financial year label for an issue date: 1 April YYYY - 31 March YYYY+1, as "YYYY-YY". */
export function documentFinancialYear(date:string){
 const y=Number(date.slice(0,4)),m=Number(date.slice(5,7));
 if(!Number.isInteger(y)||!Number.isInteger(m)||m<1||m>12)throw new Error("invalid_issue_date");
 const start=m>=4?y:y-1;
 return`${start}-${String((start+1)%100).padStart(2,"0")}`;
}

/**
 * Rule 46(b) on the NUMBER, not on the series that mints it.
 *
 * validateDocumentSeries below bounds prefix+padding at issue-configuration time, and that is where
 * a badly configured series is caught. It is not the whole rule: padStart only pads, so once the
 * serial outgrows its padding the number grows with it - a 4-character prefix on a 12-wide series is
 * legal on the day it is saved and mints a 17-character number on invoice 1,000,000,000,000. And a
 * v2 series SEEDED from a legacy row (resolveDocumentSeries) inherits that row's prefix and padding
 * without ever passing through validateDocumentSeries at all.
 *
 * lib/statutory-invoicing.ts already asserted this on the number it builds. lib/gst-accounting.ts,
 * which is what lib/subscription-billing.ts invoices every renewal through, did not - so a
 * subscription renewal could mint an invoice number GST would reject at filing, with the tax ledger
 * already written against it. Same check, same message, now on the path both share.
 */
export function assertDocumentNumberWithinRule46b(number:string){
 if(number.length>16)throw new Error("invoice_number_exceeds_16_characters");
 return number;
}

/** Rule 46(b): at most 16 characters, alphanumerics / and - only. */
export function validateDocumentSeries(prefix:string,padding:number){
 if(!/^[A-Za-z0-9/-]*$/.test(prefix))throw new Error("invoice_series_invalid_characters");
 if(!Number.isInteger(padding)||padding<1||padding>12)throw new Error("invoice_series_invalid_padding");
 if(prefix.length+padding>16)throw new Error("invoice_series_exceeds_16_characters");
}

/**
 * The active v2 series for one (entity, GSTIN, document type, FY), seeding it from the legacy row the
 * first time. Returns null when neither table has one configured - the caller raises the refusal.
 */
export async function resolveDocumentSeries(db:Db,input:{entityId:string;gstin:string;documentType:string;date:string;policyId:string}):Promise<Row|null>{
 const fy=documentFinancialYear(input.date),gstin=text(input.gstin).toUpperCase();
 const select=()=>db.prepare("SELECT * FROM finance_document_series_v2 WHERE entity_id=? AND gstin=? AND document_type=? AND financial_year=? AND status='active'").bind(input.entityId,gstin,input.documentType,fy).first<Row>();
 const existing=await select();
 if(existing)return existing;
 const legacy=await db.prepare("SELECT * FROM finance_document_series WHERE entity_id=? AND document_type=? AND status='active'").bind(input.entityId,input.documentType).first<Row>();
 if(!legacy)return null;
 // Migrated AS-IS, deliberately: a series configured before rule 46(b) was enforced here is not
 // retroactively rejected, which would stop an existing installation invoicing altogether. Callers that
 // enforce the 16-character rule (lib/statutory-invoicing.ts) still validate after resolving.
 const prefix=text(legacy.prefix),padding=Math.max(1,num(legacy.padding)||6);
 await db.prepare("INSERT OR IGNORE INTO finance_document_series_v2 (id,entity_id,gstin,document_type,financial_year,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?)")
  .bind(id("series"),input.entityId,gstin,input.documentType,fy,prefix,Math.max(1,num(legacy.next_number)||1),padding,text(legacy.policy_id)||input.policyId,Date.now()).run();
 return await select();
}

/**
 * Take the next number out of an already-resolved v2 series. The compare-and-set on next_number is what
 * makes two concurrent allocations impossible to collapse onto one serial; a caller that loses the race
 * gets null and retries.
 */
export async function allocateDocumentNumber(db:Db,series:Row):Promise<string|null>{
 const serial=num(series.next_number),padding=num(series.padding)||6,prefix=text(series.prefix);
 // Before the counter moves, so a refused number costs no serial and leaves no gap in the series.
 const number=assertDocumentNumberWithinRule46b(`${prefix}${String(serial).padStart(padding,"0")}`);
 const moved=await db.prepare("UPDATE finance_document_series_v2 SET next_number=next_number+1,updated_at=? WHERE id=? AND next_number=?").bind(Date.now(),text(series.id),serial).run();
 if(!moved?.meta||Number(moved.meta.changes)!==1)return null;
 return number;
}
