import {assignServiceInvoiceOwnership,serviceInvoiceOwnershipSnapshot,ServiceInvoiceOwnershipRequired} from "../../../lib/service-invoice-ownership";
import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{acknowledgeAccountingExport,approveStatutoryPackage,ConfigurationRequired,ensureGstAccountingTables,getGstAccountingSnapshot,issueAdjustment,recordCloseEvidence,reviewVendorTax,saveConfiguration}from"../../../lib/gst-accounting";
import{approveAnnualReturnSafe,generateAccountingExportSafe,generateAnnualReturnSafe,generateStatutoryPackageSafe,issueInvoiceSafe}from"../../../lib/finance-filing-closeout";
import{approveGstReturn,generateGstr1,generateGstr3b,generateGstr9c,getGstReturnsSnapshot}from"../../../lib/gst-returns";
import{saveStatutorySeries,voidInvoiceSerial}from"../../../lib/statutory-invoicing";
import{assignPeriodServiceOwnership,assignServiceSupplyOwnership,serviceSupplyOwnershipSnapshot}from"../../../lib/service-output-tax";
import{recordTaxPayment,taxPayableReconciliation}from"../../../lib/gst-tax-payments";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"finance.view");const db=await database();const url=new URL(request.url);if(url.searchParams.get("view")==="tax_reconciliation")return json({data:await taxPayableReconciliation(db,{periodCode:text(url.searchParams.get("period"))}),productionReady:false,liveFilingEnabled:false});const returnsFilter={returnType:url.searchParams.get("returnType")||undefined,period:url.searchParams.get("period")||undefined};return json({data:{...await getGstAccountingSnapshot(db),serviceInvoices:[...await serviceInvoiceOwnershipSnapshot(db),...await serviceSupplyOwnershipSnapshot(db)]},returns:await getGstReturnsSnapshot(db,returnsFilter),actor:{email:actor.email,roleCode:actor.roleCode},productionReady:false});}catch(error){return authError(error,"Unable to load GST/accounting control");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database(),body=await request.json() as Record<string,unknown>,action=String(body.action||"");let data:unknown;
 // A completed service with no invoice is listed as "SUPPLY:<key>" and assigned as a supply (lib/service-output-tax.ts).
 if(action==="assign_service_invoice_owner"){await ensureGstAccountingTables(db);const invoiceId=text(body.invoiceId),scope={entityId:text(body.entityId),registrationId:text(body.registrationId),reason:text(body.reason)};data=invoiceId.startsWith("SUPPLY:")?await assignServiceSupplyOwnership(db,{...scope,supplyKey:invoiceId.slice(7)},actor.email):await assignServiceInvoiceOwnership(db,{...scope,invoiceId},actor.email);}
 else if(action==="assign_period_service_owner"){await ensureGstAccountingTables(db);data=await assignPeriodServiceOwnership(db,{periodCode:text(body.periodCode),entityId:text(body.entityId),registrationId:text(body.registrationId),reason:text(body.reason)},actor.email);}
 else if(action==="record_tax_payment")data=await recordTaxPayment(db,{taxKind:text(body.taxKind),periodCode:text(body.periodCode),amount:Number(body.amount),challanReference:text(body.challanReference),paidOn:text(body.paidOn),reason:text(body.reason),returnReference:text(body.returnReference)||null},actor.email);
 else if(action==="issue_invoice")data=await issueInvoiceSafe(db,body,actor.email);
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
 }catch(error){if(error instanceof ConfigurationRequired||error instanceof ServiceInvoiceOwnershipRequired)return json({error:"configuration_required",configurationKey:error.key,productionReady:false},409);return authError(error,"GST/accounting action failed");}}
