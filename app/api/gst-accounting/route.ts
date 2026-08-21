import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{acknowledgeAccountingExport,approveStatutoryPackage,ConfigurationRequired,getGstAccountingSnapshot,issueAdjustment,recordCloseEvidence,reviewVendorTax,saveConfiguration}from"../../../lib/gst-accounting";
import{approveAnnualReturnSafe,generateAccountingExportSafe,generateAnnualReturnSafe,generateStatutoryPackageSafe,issueInvoiceSafe}from"../../../lib/finance-filing-closeout";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"finance.view");const db=await database();return json({data:await getGstAccountingSnapshot(db),actor:{email:actor.email,roleCode:actor.roleCode},productionReady:false});}catch(error){return authError(error,"Unable to load GST/accounting control");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database(),body=await request.json() as Record<string,unknown>,action=String(body.action||"");let data:unknown;
 if(action==="issue_invoice")data=await issueInvoiceSafe(db,body,actor.email);
 else if(action==="issue_adjustment")data=await issueAdjustment(db,body,actor.email);
 else if(action==="review_vendor_tax")data=await reviewVendorTax(db,body,actor.email);
 else if(action==="generate_statutory_package")data=await generateStatutoryPackageSafe(db,body,actor.email);
 else if(action==="approve_statutory_package")data=await approveStatutoryPackage(db,body,actor.email);
 else if(action==="generate_annual_return")data=await generateAnnualReturnSafe(db,body,actor.email);
 else if(action==="approve_annual_return")data=await approveAnnualReturnSafe(db,body,actor.email);
 else if(action==="generate_accounting_export")data=await generateAccountingExportSafe(db,body,actor.email);
 else if(action==="acknowledge_accounting_export")data=await acknowledgeAccountingExport(db,body,actor.email);
 else if(action==="record_close_evidence")data=await recordCloseEvidence(db,body,actor.email);
 else data=await saveConfiguration(db,body,actor.email);
 await securityAudit(db,actor,`gst.accounting.${action||"configuration"}`,"gst_accounting",String((data as Record<string,unknown>)?.id||(data as Record<string,unknown>)?.entityId||"configuration"),"completed",{productionReady:false,liveFiling:false,liveAccountingPost:false});
 return json({data,productionReady:false,liveFilingEnabled:false,liveAccountingPostEnabled:false});
 }catch(error){if(error instanceof ConfigurationRequired)return json({error:"configuration_required",configurationKey:error.key,productionReady:false},409);return authError(error,"GST/accounting action failed");}}
