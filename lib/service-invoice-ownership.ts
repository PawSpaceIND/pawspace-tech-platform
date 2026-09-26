/** Explicit legal ownership for service invoices. Never infer an entity from the selected report.
 * service_supply_ownership holds the same explicit assignment for a filed supply that has no service invoice - a completed
 * booking nobody invoiced by hand, a funeral case or order, a vertical the owner has not classified yet - keyed the way
 * lib/service-output-tax.ts keys it ("booking:BK-1"). A booking that has an invoice follows the invoice's assignment.
 * Ownership is permanent, and a month that is closed can no longer be assigned: the monthly close refuses while anything in
 * the month is unassigned (lib/finance-monthly-close.ts), so a closed month never needs it (audit G22). */
import{governedJsonError}from"./governed-http-error";
type Row=Record<string,unknown>;
export type ServiceInvoiceScope={entityId:string;registrationId:string};
export class ServiceInvoiceOwnershipRequired extends Error{
 readonly key="service_invoice_ownership";
 readonly unassigned:number;
 constructor(unassigned=0){super(`Assign each service invoice and completed service to its legal entity and GST registration before generating statutory returns${unassigned>0?` (${unassigned} not assigned yet)`:""}.`);this.unassigned=unassigned;}
}
export async function ensureServiceInvoiceOwnershipTables(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS service_invoice_ownership (invoice_id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,assigned_by TEXT NOT NULL,reason TEXT NOT NULL,assigned_at INTEGER NOT NULL)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS service_supply_ownership (supply_key TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,assigned_by TEXT NOT NULL,reason TEXT NOT NULL,assigned_at INTEGER NOT NULL)").run();
}
/** Refuses unless the registration is active and belongs to the named active entity. */
export async function assertOwnershipRegistration(db:D1Database,input:ServiceInvoiceScope){
 const registration=await db.prepare("SELECT r.id FROM tax_registrations r JOIN finance_entities e ON e.id=r.entity_id WHERE r.id=? AND r.entity_id=? AND r.status='active' AND e.status='active'").bind(input.registrationId,input.entityId).first<Row>();
 if(!registration)throw new Response("An active registration belonging to the selected active entity is required",{status:409});
}
/** Refuses when the month (YYYY-MM) is closed and locked: its figures are final. */
export async function assertOwnershipPeriodOpen(db:D1Database,period:string){
 const locked=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(period).first<Row>().catch(()=>null);
 if(locked?.status==="locked")throw governedJsonError({error:`${period} is closed and locked, so ownership can no longer be assigned in it`},409);
}
export async function assignServiceInvoiceOwnership(db:D1Database,input:ServiceInvoiceScope&{invoiceId:string;reason:string},actor:string){
 await ensureServiceInvoiceOwnershipTables(db);
 if(!input.invoiceId||!input.entityId||!input.registrationId||input.reason.trim().length<8)throw new Response("Invoice, entity, registration and a clear ownership reason are required",{status:400});
 await assertOwnershipRegistration(db,input);
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_invoices'").first<Row>();
 if(!exists)throw new Response("An issued service invoice is required",{status:409});
 const invoice=await db.prepare("SELECT id,issued_at FROM booking_invoices WHERE id=? AND status IN ('issued','issued_uat') AND issued_at>0").bind(input.invoiceId).first<Row>();
 if(!invoice)throw new Response("An issued service invoice is required",{status:409});
 await assertOwnershipPeriodOpen(db,new Date(Number(invoice.issued_at)+330*60_000).toISOString().slice(0,7));
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
