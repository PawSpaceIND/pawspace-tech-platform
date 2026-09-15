import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{acknowledgeAccountingExport,approveStatutoryPackage,ConfigurationRequired,getGstAccountingSnapshot,issueAdjustment,recordCloseEvidence,reviewVendorTax,saveConfiguration}from"../../../lib/gst-accounting";
import{approveAnnualReturnSafe,generateAccountingExportSafe,generateAnnualReturnSafe,generateStatutoryPackageSafe,issueInvoiceSafe}from"../../../lib/finance-filing-closeout";
import{approveGstReturn,generateGstr1,generateGstr3b,generateGstr9c,getGstReturnsSnapshot}from"../../../lib/gst-returns";
import{saveStatutorySeries,voidInvoiceSerial}from"../../../lib/statutory-invoicing";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

/* Business-rule refusals, translated for the operator. [FIN-W2-G]
 *
 * The statutory engines behind this route signal a refused BUSINESS RULE with a bare
 * `throw new Error("<code>")`. lib/server-auth.ts authError() trusts only governed Response objects
 * and branded client errors, so every one of these reached /team/finance/statutory as an HTTP 500
 * carrying "GST/accounting action failed" - a server-fault status with no reason - when the real
 * answer was "this credit note exceeds the invoice it adjusts" or "that financial year has no
 * invoice series". An operator cannot act on a 500.
 *
 * The map is an explicit ALLOW-LIST and the wording is written HERE, never echoed from the thrown
 * error, so an unexpected failure (a SQLite message, an upstream URL) still falls through to
 * authError()'s redacted 500. No engine is modified and no status an existing caller relies on moves.
 *
 * The two-person wording deliberately does not repeat the internal rule identifier or the column it
 * reads: tests/finance-statutory-execution.test.mjs pins that the caller-visible body leaks neither,
 * and that guarantee is worth keeping. The operator still learns exactly what must happen next.
 */
const BUSINESS_RULE_REFUSALS:Record<string,{status:number;message:string}>={
 reason_required:{status:400,message:"A reason of at least 5 characters is required for this configuration change."},
 policy_required:{status:400,message:"A tax policy document is required."},
 approval_reference_required:{status:400,message:"An approval reference (the CA/Finance sign-off) is required before this can be approved."},
 unsupported_configuration_action:{status:400,message:"That configuration action is not supported."},
 invoice_source_required:{status:400,message:"Entity, issue date and source event key are all required to issue an invoice."},
 invoice_lines_required:{status:400,message:"An invoice must carry at least one line."},
 invalid_issue_date:{status:400,message:"The issue date must be a real YYYY-MM-DD date."},
 period_locked:{status:409,message:"That accounting period is locked; it can no longer be posted to."},
 invoice_number_exceeds_16_characters:{status:409,message:"The generated invoice number is longer than the 16 characters Rule 46(b) allows; shorten the series prefix or padding."},
 invoice_serial_cas_failed:{status:409,message:"The invoice serial was claimed by another write; nothing was issued. Retry."},
 invoice_not_found:{status:404,message:"No issued invoice with that id."},
 invalid_adjustment_kind:{status:400,message:"An adjustment must be a credit_note or a debit_note."},
 invalid_adjustment_amount:{status:400,message:"The adjustment amount must be positive and its tax cannot be negative."},
 credit_note_exceeds_invoice:{status:409,message:"Credit notes against this invoice would exceed the invoice they adjust."},
 bill_not_found:{status:404,message:"No vendor bill with that id."},
 invalid_review_status:{status:400,message:"The review status must be eligible, ineligible, held or review_required."},
 package_not_found:{status:404,message:"No statutory package with that id."},
 maker_checker_required:{status:409,message:"Two-person rule: whoever prepared this draft cannot approve it. A different Finance/CA approver must sign it off."},
 annual_return_source_required:{status:400,message:"An entity and a GST registration are required to generate the annual return."},
 statutory_package_scope_required:{status:400,message:"An entity, a GST registration and a YYYY-MM period are all required to prepare a statutory package."},
 valid_financial_year_required:{status:400,message:"A valid financial year is required, for example 2026-27."},
 annual_return_not_found:{status:404,message:"No annual return with that id."},
 annual_return_not_draft:{status:409,message:"That annual return has already been signed off."},
 annual_reconciliation_not_clean:{status:409,message:"Every month of the financial year needs an approved monthly statutory package before the annual return can be approved. Approve the missing months, then regenerate the annual return."},
 accounting_export_scope_required:{status:400,message:"An entity and a YYYY-MM period are required for an accounting export."},
 export_not_found:{status:404,message:"No accounting export run with that id."},
 ack_reference_required:{status:400,message:"An acknowledgement reference is required to record the export as received."},
 gstr1_scope_required:{status:400,message:"An entity and a YYYY-MM period are required to generate GSTR-1."},
 gstr3b_scope_required:{status:400,message:"An entity and a YYYY-MM period are required to generate GSTR-3B."},
 gst_return_not_found:{status:404,message:"No GST return draft with that id."},
 gst_return_not_draft:{status:409,message:"That GST return has already been signed off."},
 invalid_financial_year:{status:400,message:"The invoice series financial year must be written YYYY-YY, for example 2026-27."},
 invalid_gstin:{status:400,message:"That GSTIN is not a valid 15-character registration number."},
 invoice_series_invalid_characters:{status:400,message:"An invoice series prefix may only contain letters, digits, / and -."},
 invoice_series_invalid_padding:{status:400,message:"The invoice series padding must be between 1 and 12 digits."},
 invoice_series_exceeds_16_characters:{status:400,message:"Prefix plus padding may not exceed the 16 characters Rule 46(b) allows."},
 void_reason_required:{status:400,message:"Voiding an invoice serial needs a recorded reason of at least 8 characters."},
 issued_invoice_number_cannot_be_voided:{status:409,message:"That invoice number has already been issued; issue a credit note instead of voiding the serial."},
};
function businessRuleRefusal(error:unknown){
 if(!(error instanceof Error))return null;
 const rule=BUSINESS_RULE_REFUSALS[error.message];
 return rule?json({error:rule.message,productionReady:false,liveFilingEnabled:false},rule.status):null;
}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"finance.view");const db=await database();const url=new URL(request.url);const returnsFilter={returnType:url.searchParams.get("returnType")||undefined,period:url.searchParams.get("period")||undefined};return json({data:await getGstAccountingSnapshot(db),returns:await getGstReturnsSnapshot(db,returnsFilter),actor:{email:actor.email,roleCode:actor.roleCode},canManage:hasPermission(actor.permissions,"finance.manage"),productionReady:false});}catch(error){return authError(error,"Unable to load GST/accounting control");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database(),body=await request.json() as Record<string,unknown>,action=String(body.action||"");let data:unknown;
 if(action==="issue_invoice")data=await issueInvoiceSafe(db,body,actor.email);
 else if(action==="save_statutory_series")data=await saveStatutorySeries(db,{entityId:text(body.entityId),gstin:text(body.gstin),documentType:text(body.documentType),financialYear:text(body.financialYear),prefix:text(body.prefix),padding:Number(body.padding),policyId:text(body.policyId),nextNumber:body.nextNumber==null?undefined:Number(body.nextNumber)},actor.email);
 else if(action==="void_invoice_serial")data=await voidInvoiceSerial(db,{entityId:text(body.entityId),gstin:text(body.gstin),documentType:text(body.documentType),financialYear:text(body.financialYear),invoiceNumber:text(body.invoiceNumber),serialNumber:Number(body.serialNumber),reason:text(body.reason),sourceReference:text(body.sourceReference)||undefined},actor.email);
 else if(action==="issue_adjustment")data=await issueAdjustment(db,body,actor.email);
 else if(action==="review_vendor_tax")data=await reviewVendorTax(db,body,actor.email);
 else if(action==="generate_statutory_package")data=await generateStatutoryPackageSafe(db,body,actor.email);
 else if(action==="approve_statutory_package")data=await approveStatutoryPackage(db,body,actor.email);
 else if(action==="generate_annual_return")data=await generateAnnualReturnSafe(db,body,actor.email);
 else if(action==="approve_annual_return")data=await approveAnnualReturnSafe(db,body,actor.email);
 else if(action==="generate_accounting_export")data=await generateAccountingExportSafe(db,body,actor.email);
 else if(action==="acknowledge_accounting_export")data=await acknowledgeAccountingExport(db,body,actor.email);
 else if(action==="record_close_evidence")data=await recordCloseEvidence(db,body,actor.email);
 else if(action==="generate_gstr1")data=await generateGstr1(db,body,actor.email);
 else if(action==="generate_gstr3b")data=await generateGstr3b(db,body,actor.email);
 else if(action==="generate_gstr9c")data=await generateGstr9c(db,body,actor.email);
 else if(action==="approve_gst_return")data=await approveGstReturn(db,body,actor.email);
 else data=await saveConfiguration(db,body,actor.email);
 await securityAudit(db,actor,`gst.accounting.${action||"configuration"}`,"gst_accounting",String((data as Record<string,unknown>)?.id||(data as Record<string,unknown>)?.entityId||"configuration"),"completed",{productionReady:false,liveFiling:false,liveAccountingPost:false});
 return json({data,productionReady:false,liveFilingEnabled:false,liveAccountingPostEnabled:false});
 }catch(error){if(error instanceof ConfigurationRequired)return json({error:"configuration_required",configurationKey:error.key,productionReady:false},409);const refused=businessRuleRefusal(error);if(refused)return refused;return authError(error,"GST/accounting action failed");}}
