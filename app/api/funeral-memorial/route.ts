import{authError,authFailure,database,requireCustomerOwnership,requirePermission,requireProviderOwnership,resolveActor,securityAudit,type AuthenticatedActor}from"../../../lib/server-auth";
import{ensureFuneralMemorialTables,createFuneralCase,funeralMemorialReadiness,funeralSensitiveTemplates,getFuneralCase,getFuneralReport,getFuneralServiceConfig,listFuneralCases,mutateFuneralCase,saveFuneralServiceConfig,type FuneralServiceType,type MemorialOption}from"../../../lib/funeral-memorial-governance";
import{resolveAssignmentPolicy}from"../../../lib/provider-assignment-policy";
import{postCollectionEvent}from"../../../lib/collection-ledger";
import{findIdentityBinding}from"../../../lib/identity-binding";
import{hasPermission}from"../../../lib/platform-security";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

/**
 * The coordination actions the PARTNER screen (/partner/funeral) issues. Every one of them was
 * falling through to `requirePermission(actor,"bookings.manage")`, which the service_provider role
 * does not hold, so an assigned funeral coordinator got "Permission denied" on a screen that lives in
 * the partner namespace and is named "Assigned service requests". The list branch was the same story
 * one call earlier: it demanded customers.view.
 *
 * The fix is NOT to widen the permissions. These actions stay bookings.manage for staff; a provider
 * reaches them only with bookings.view AND an identity binding to the provider the CASE names. That
 * is the same subject binding every other provider-scoped route uses (requireProviderOwnership), so a
 * coordinator sees and drives their own queue and nothing else. [partner funeral 403]
 */
const funeralCoordinatorActions=new Set(["coordinate_pickup","complete_milestone","register_media","update_ash_collection","close_case"]);

/** The provider this identity IS: binding first, then the legacy per-environment link table. Same order as app/api/partner-job-feed. */
async function ownProviderId(db:Db,actor:AuthenticatedActor){
 const binding=await findIdentityBinding(db,{identitySource:actor.identitySource,principalType:actor.principalType,principalKey:actor.principalKey,subjectType:"provider"});
 if(binding)return text(binding.subject_id);
 const legacy=await db.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=?").bind(actor.email).first<Row>().catch(()=>null);
 return legacy&&legacy.status==="active"?text(legacy.provider_id):"";
}

/**
 * Staff authority is unchanged - bookings.manage carries these outright. Anyone else must hold
 * bookings.view and own the provider the case is assigned to, in either slot: the coordinating agent
 * or the vendor. An unassigned case has no coordinator, so nobody reaches it this way.
 */
async function requireFuneralCoordinator(db:Db,actor:AuthenticatedActor,item:Row){
 if(hasPermission(actor.permissions,"bookings.manage"))return actor;
 requirePermission(actor,"bookings.view");
 const assigned=[text(item.assigned_agent_id),text(item.vendor_id)].filter(value=>value.length>0);
 if(!assigned.length)throw authFailure("This funeral or memorial request has no assigned coordinator",403);
 let refusal:unknown=authFailure("Funeral coordinator assignment denied",403);
 for(const providerId of assigned){
  try{return await requireProviderOwnership(db,actor,providerId);}catch(error){refusal=error;}
 }
 throw refusal;
}

type Body={action?:string;caseId?:string;customerId?:string;petName?:string;petSpecies?:string;pickupAddress?:string;alternateContact?:string;serviceType?:FuneralServiceType;memorialOption?:MemorialOption;urgency?:string;mediaType?:string;objectId?:string;note?:string;agentId?:string;vendorId?:string;milestoneCode?:string;amount?:number;paymentMode?:"internal_uat"|"cash_uat";paymentReference?:string;preferredAt?:string;ashStatus?:string;recordType?:string;reference?:string;refundAmount?:number;reason?:string;decision?:"approved"|"rejected"|"completed";resolutionMode?:"external_refund"|"wallet_credit_uat";closureNote?:string;enabled?:boolean;baseAmount?:number|null;cashAllowed?:boolean};
const json=(value:unknown,status=200)=>Response.json(value,{status});

/*
 * The finance projection: the commercial record, and nothing that identifies the customer.
 *
 * A funeral case carries the owner's pickup address and alternate contact number - which is precisely
 * why the unscoped staff read below demands customers.view. The `finance` role holds neither that nor
 * bookings.view, so /team/finance/funeral-memorial, the screen that sets the approved amount, records
 * payment and resolves refunds, was refused to the only role that can perform those actions.
 *
 * ?scope=finance is a separate read at finance.view over an ALLOW-LIST of the fields that screen
 * renders. pickup_address, alternate_contact and customer_id are not in it and cannot leave through
 * this path; a column added to funeral_cases later is excluded by default rather than included.
 */
const FUNERAL_FINANCE_FIELDS=["id","status","service_type","memorial_option","urgency","pet_name","pet_species","vendor_id","assigned_agent_id","certificate_status","support_status","created_at","updated_at"];
const FUNERAL_FINANCE_NESTED=["payment","invoice","refunds","vendorCost","settlement","reconciliation"];
function funeralFinanceView(item:Row){const out:Row={};for(const field of [...FUNERAL_FINANCE_FIELDS,...FUNERAL_FINANCE_NESTED])if(field in item)out[field]=item[field];return out;}

export async function GET(request:Request){try{const url=new URL(request.url),db=await database(),actor=await resolveActor(request);if(url.searchParams.get("config")==="1"){requirePermission(actor,"pricing.view");return json({data:await getFuneralServiceConfig(db),readiness:funeralMemorialReadiness});}if(url.searchParams.get("report")==="summary"){requirePermission(actor,"reports.view");return json({data:await getFuneralReport(db),readiness:funeralMemorialReadiness});}const caseId=String(url.searchParams.get("caseId")||""),customerId=String(url.searchParams.get("customerId")||""),scope=String(url.searchParams.get("scope")||""),customerScope=scope==="customer",providerScope=scope==="provider",financeScope=scope==="finance";if(caseId){const item=await getFuneralCase(db,caseId);if(!item)return json({error:"Funeral or memorial request not found"},404);if(customerScope){requirePermission(actor,"scheduling.book");await requireCustomerOwnership(db,actor,String((item as Record<string,unknown>).customer_id));}else if(providerScope)await requireFuneralCoordinator(db,actor,item as Row);else if(financeScope){requirePermission(actor,"finance.view");return json({data:funeralFinanceView(item as Row),readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}else requirePermission(actor,"customers.view");return json({data:item,readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}if(customerScope){requirePermission(actor,"scheduling.book");if(!customerId)return json({error:"Customer ID is required"},400);await requireCustomerOwnership(db,actor,customerId);return json({data:await listFuneralCases(db,{customerId}),readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}if(providerScope){requirePermission(actor,"bookings.view");const providerId=text(url.searchParams.get("providerId"))||await ownProviderId(db,actor);if(!providerId)return json({error:"No active provider identity is linked to this session"},403);await requireProviderOwnership(db,actor,providerId);await ensureFuneralMemorialTables(db);const status=String(url.searchParams.get("status")||""),serviceType=String(url.searchParams.get("serviceType")||"");const rows=await db.prepare("SELECT * FROM funeral_cases WHERE (assigned_agent_id=? OR vendor_id=?) AND (?='' OR status=?) AND (?='' OR service_type=?) ORDER BY created_at DESC LIMIT 100").bind(providerId,providerId,status,status,serviceType,serviceType).all<Row>();return json({data:rows.results,readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates,scope:"provider",providerId});}if(financeScope){requirePermission(actor,"finance.view");const rows=await listFuneralCases(db,{status:String(url.searchParams.get("status")||"")||undefined,serviceType:String(url.searchParams.get("serviceType")||"")||undefined});return json({data:rows.map(row=>funeralFinanceView(row as Row)),readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}requirePermission(actor,"customers.view");return json({data:await listFuneralCases(db,{status:String(url.searchParams.get("status")||"")||undefined,serviceType:String(url.searchParams.get("serviceType")||"")||undefined}),readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}catch(error){return authError(error,"Unable to load funeral or memorial requests");}}

export async function POST(request:Request){try{const body=await request.json() as Body,db=await database(),actor=await resolveActor(request),action=String(body.action||"create");if(action==="save_service_config"){requirePermission(actor,"pricing.manage");const result=await saveFuneralServiceConfig(db,{serviceType:body.serviceType||"cremation",enabled:body.enabled!==false,baseAmount:body.baseAmount,cashAllowed:Boolean(body.cashAllowed)},actor.email);await securityAudit(db,actor,"funeral.save_service_config","funeral_service_config",String(body.serviceType||"cremation"),"completed",{liveMoney:false});return json({data:result.config,readiness:funeralMemorialReadiness});}if(action==="create"){requirePermission(actor,"scheduling.book");const customerId=String(body.customerId||"");await requireCustomerOwnership(db,actor,customerId);const data=await createFuneralCase(db,{customerId,petName:String(body.petName||""),petSpecies:String(body.petSpecies||"pet"),pickupAddress:String(body.pickupAddress||""),alternateContact:String(body.alternateContact||"")||undefined,serviceType:body.serviceType||"cremation",memorialOption:body.memorialOption||"none",urgency:String(body.urgency||"urgent")},actor.email);await securityAudit(db,actor,"funeral.create","funeral_case",String((data as Record<string,unknown>)?.id||""),"completed",{liveMoney:false});return json({data,readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates},201);}const caseId=String(body.caseId||"");if(!caseId)return json({error:"Funeral or memorial request ID is required"},400);const existing=await getFuneralCase(db,caseId);if(!existing)return json({error:"Funeral or memorial request not found"},404);if(["qualify","assign_vendor"].includes(action)){const policy=(await resolveAssignmentPolicy(db,"funeral_memorial","blr")).config;if(!["manual_workflow","ops_select"].includes(policy.assignmentMode))return json({error:"Configured assignment policy is not supported by this high-touch workflow",code:"unsupported_assignment_mode"},409);}if(action==="pay_cash"||action==="pay_online_sandbox"){requirePermission(actor,"scheduling.book");await requireCustomerOwnership(db,actor,String((existing as Record<string,unknown>).customer_id));const cash=action==="pay_cash";const payment= (existing as {payment?:{amount?:number}|null}).payment;const amount=Number(body.amount||payment?.amount||0);if(!(amount>0))return json({error:"A quoted funeral amount is required before payment can be recorded"},409);const paymentReference=`${cash?"CASH":"SANDBOX"}-${caseId}-${Date.now()}`;const data=await mutateFuneralCase(db,{caseId,action:"record_payment",actorId:actor.email,amount,paymentMode:cash?"cash_uat":"internal_uat",paymentReference});const today=new Date().toISOString().slice(0,10);await postCollectionEvent(db,{event:cash?"cash_collected_confirmed":"online_payment_captured",bookingId:caseId,customerId:String((existing as Record<string,unknown>).customer_id||""),serviceCode:"funeral",paymentId:paymentReference,amount,paymentMethod:cash?"cash":"upi",collectorId:actor.email,entryDate:today,actorId:actor.email,manualEntry:cash});await securityAudit(db,actor,cash?"funeral.pay_cash":"funeral.pay_online_sandbox","funeral_case",caseId,"completed",{liveMoney:false,instrument:cash?"cash":"gateway"});return json({data,readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}const customerActions=new Set(["register_customer_media","schedule_ash_collection","request_refund","open_support"]),financeActions=new Set(["set_service_amount","record_payment","resolve_refund"]);if(customerActions.has(action)){requirePermission(actor,"scheduling.book");await requireCustomerOwnership(db,actor,String((existing as Record<string,unknown>).customer_id));}else if(financeActions.has(action))requirePermission(actor,"finance.manage");else if(funeralCoordinatorActions.has(action))await requireFuneralCoordinator(db,actor,existing as Row);else requirePermission(actor,"bookings.manage");const data=await mutateFuneralCase(db,{caseId,action,actorId:actor.email,mediaType:body.mediaType,objectId:body.objectId,note:body.note,agentId:body.agentId,vendorId:body.vendorId,milestoneCode:body.milestoneCode,amount:body.amount,paymentMode:body.paymentMode,paymentReference:body.paymentReference,preferredAt:body.preferredAt,ashStatus:body.ashStatus,recordType:body.recordType,reference:body.reference,refundAmount:body.refundAmount,reason:body.reason,decision:body.decision,resolutionMode:body.resolutionMode,closureNote:body.closureNote});await securityAudit(db,actor,`funeral.${action}`,"funeral_case",caseId,"completed",{liveMoney:false});return json({data,readiness:funeralMemorialReadiness,templates:funeralSensitiveTemplates});}catch(error){return authError(error,"Unable to update funeral or memorial request");}}
