/** Explicit legal ownership for service invoices. Never infer an entity from the selected report. */
type Row=Record<string,unknown>;
export type ServiceInvoiceScope={entityId:string;registrationId:string};
export class ServiceInvoiceOwnershipRequired extends Error{
 readonly key="service_invoice_ownership";
 constructor(){super("Assign each service invoice to its legal entity and GST registration before generating statutory returns.");}
}
export async function ensureServiceInvoiceOwnershipTables(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS service_invoice_ownership (invoice_id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,assigned_by TEXT NOT NULL,reason TEXT NOT NULL,assigned_at INTEGER NOT NULL)").run();
}
export async function assignServiceInvoiceOwnership(db:D1Database,input:ServiceInvoiceScope&{invoiceId:string;reason:string},actor:string){
 await ensureServiceInvoiceOwnershipTables(db);
 if(!input.invoiceId||!input.entityId||!input.registrationId||input.reason.trim().length<8)throw new Response("Invoice, entity, registration and a clear ownership reason are required",{status:400});
 const registration=await db.prepare("SELECT r.id FROM tax_registrations r JOIN finance_entities e ON e.id=r.entity_id WHERE r.id=? AND r.entity_id=? AND r.status='active' AND e.status='active'").bind(input.registrationId,input.entityId).first<Row>();
 if(!registration)throw new Response("An active registration belonging to the selected active entity is required",{status:409});
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_invoices'").first<Row>();
 if(!exists)throw new Response("An issued service invoice is required",{status:409});
 const invoice=await db.prepare("SELECT id,issued_at FROM booking_invoices WHERE id=? AND status IN ('issued','issued_uat') AND issued_at>0").bind(input.invoiceId).first<Row>();
 if(!invoice)throw new Response("An issued service invoice is required",{status:409});
 const period=new Date(Number(invoice.issued_at)+330*60_000).toISOString().slice(0,7);
 const locked=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(period).first<Row>();
 if(locked?.status==="locked")throw new Response("The invoice period is locked",{status:409});
 await db.prepare("INSERT OR IGNORE INTO service_invoice_ownership (invoice_id,entity_id,registration_id,assigned_by,reason,assigned_at) VALUES (?,?,?,?,?,?)").bind(input.invoiceId,input.entityId,input.registrationId,actor,input.reason.trim(),Date.now()).run();
 const stored=await db.prepare("SELECT * FROM service_invoice_ownership WHERE invoice_id=?").bind(input.invoiceId).first<Row>();
 if(stored?.entity_id!==input.entityId||stored?.registration_id!==input.registrationId)throw new Response("This invoice already belongs to a different entity or registration; ownership cannot be overwritten",{status:409});
 return stored;
}

export async function serviceInvoiceOwnershipSnapshot(db:D1Database){
 await ensureServiceInvoiceOwnershipTables(db);
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_invoices'").first<Row>();
 if(!exists)return [];
 const rows=await db.prepare("SELECT bi.id,bi.booking_id,bi.invoice_number,bi.gross_amount,bi.tax_amount,bi.issued_at,o.entity_id,o.registration_id FROM booking_invoices bi LEFT JOIN service_invoice_ownership o ON o.invoice_id=bi.id WHERE bi.status!='cancelled' ORDER BY (o.invoice_id IS NULL) DESC,bi.issued_at DESC LIMIT 100").all<Row>();
 return rows.results;
}
