/**
 * Default commission by service (owner decision C, 27 Sept 2026): "30% but this can be changed or kept as default for all
 * service providers on commission basis, but if needed we will customise the value as per assignment."
 *
 *  - Every commission service (COMMISSION_DEFAULT_SERVICES) has an active service default (provider_id NULL). A service with
 *    no active default is seeded at PawSpace 30% through the normal path: saveCommercialTerm drafts it and the guarded
 *    activation activates it, both audited, under the owner's decision (DEFAULT_SEED_REFERENCE). It starts the day it is
 *    seeded (never back-dated). Finance sees it as "set automatically" until a person approves it (reapproveCommercialTerm).
 *    A default Finance set is never touched, even one activated while the seed runs (the batch re-checks), and a change
 *    waiting for approval keeps waiting.
 *  - Changing a default is maker-checker like provider terms: one person proposes PawSpace's commission (10-40%), a reason
 *    and a start date from today (never back-dated); a different person approves exactly the drafts they were shown, with an
 *    approval reference, and the set applies in one guarded batch (activateTermsTogether). One proposal can give every
 *    service the same default. No start date may fall in a month whose books are locked.
 *  - For a booking the engine still uses an approved order override first, then the provider's own term, then this default
 *    (COMMISSION_RESOLUTION_ORDER).
 */
import{GovernedRefusal}from"./governed-http-error";
import{SYSTEM_MADE_DRAFT,activateTermsTogether,ensureCommercialTermsTables,lockedMonthProblem,saveCommercialTerm,type EngagementModel}from"./provider-commercial-terms";
import{COMMISSION_DEFAULT_SERVICES,COMMISSION_RESOLUTION_ORDER,DEFAULT_COMMISSION_SEED_APPROVER,PAWSPACE_COMMISSION_DEFAULT_PERCENT,PAWSPACE_COMMISSION_MAX_PERCENT,PAWSPACE_COMMISSION_MIN_PERCENT,RANGE_GOVERNED_MODELS,commissionFromProviderShare,engagementModelFor,isFuneralService,isSystemActor,pawspaceCommissionProblem,personApprovalNeeded,providerShareFromCommission,providerShareRangeProblem,serviceDefaultStartProblem}from"./commission-range";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const refuse=(message:string,status=400)=>new GovernedRefusal(message,status);
const actorKey=(v:unknown)=>text(v).toLowerCase();
/** The engine's date: bookings resolve their terms on the UTC date of scheduled_start. */
const today=()=>new Date().toISOString().slice(0,10);
const serviceLabel=(code:string)=>code.replaceAll("_"," ");
/* Fail closed: a batch result that does not report a change count is never read as applied. */
const changed=(result:unknown)=>Number((result as {meta?:{changes?:number}}|undefined)?.meta?.changes??0)>0;
const idList=(value:unknown)=>[...new Set((Array.isArray(value)?value:[]).map(text).filter(Boolean))];

/** Who seeds a missing default (the maker), and the owner's decision it is approved under (the checker is DEFAULT_COMMISSION_SEED_APPROVER). */
export const DEFAULT_SEED_MAKER="system:default-commission-seed";
export const DEFAULT_SEED_REFERENCE="OWNER-DECISION-C-2026-09-27";
const SEED_REASON=`Owner decision C (27 Sept 2026): PawSpace's default commission is ${PAWSPACE_COMMISSION_DEFAULT_PERCENT}% for every commission service`;
const CHANGED_SINCE_LOADED="The default commission changes waiting for approval changed after you loaded them. Reload, check them and approve again.";

const summary=(row:Row)=>{const model=text(row.engagement_model);return{termId:text(row.id),serviceCode:text(row.service_code),status:text(row.status),engagementModel:model,pawspaceCommissionPercent:model==="direct_employee"?null:commissionFromProviderShare(num(row.provider_share_pct)),effectiveFrom:text(row.effective_from),createdBy:text(row.created_by),approvedBy:text(row.approved_by)||null,approvalReference:text(row.approval_reference)||null,needsPersonApproval:text(row.status)==="active"?personApprovalNeeded(row.approved_by):null,reason:text(row.reason)};};
export type ServiceDefaultTerm=ReturnType<typeof summary>;

/** Every service default in use or waiting, newest first per service. */
async function defaultRows(db:Db){return(await db.prepare("SELECT * FROM provider_commercial_terms WHERE provider_id IS NULL AND status IN ('active','draft') ORDER BY service_code,effective_from DESC,version DESC").all<Row>()).results;}
/** The services in the section: every commission service, and any other non-funeral service that already has a default. */
function sectionServices(rows:ReadonlyArray<Row>){return[...new Set([...COMMISSION_DEFAULT_SERVICES,...rows.map(r=>text(r.service_code).toLowerCase()).filter(code=>code&&!isFuneralService(code))])].sort();}
/* Withdraw a default change still waiting. The audit row is written only if this call withdrew it. */
function withdrawDraft(db:Db,input:{termId:string;actorId:string;detail:Record<string,unknown>}){const now=Date.now();return db.batch([
 db.prepare("UPDATE provider_commercial_terms SET status='withdrawn',updated_at=? WHERE id=? AND status='draft'").bind(now,input.termId),
 db.prepare("INSERT INTO commercial_terms_audit (id,term_id,action,actor_id,detail_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM provider_commercial_terms WHERE id=? AND status='withdrawn' AND updated_at=?)").bind(crypto.randomUUID(),input.termId,"withdrawn",input.actorId,JSON.stringify(input.detail),now,input.termId,now),
]);}

/**
 * Seed PawSpace's 30% default for each commission service with no active default (none in force, none scheduled). Idempotent.
 * A default Finance set is never touched: an active one (in force or starting later) means the service is skipped, and a change
 * still waiting for approval stays waiting (once approved it takes over from its own start date). The activation re-checks
 * inside its batch that no active default appeared meanwhile; if one did, the seed's draft is withdrawn and that one is kept.
 * Runs from Finance > Partners and from the Worker's scheduled tick; once every service has a default it costs one SELECT.
 */
export async function seedMissingServiceCommissionDefaults(db:Db){
 await ensureCommercialTermsTables(db);
 const rows=await defaultRows(db),present=new Set(rows.filter(r=>text(r.status)==="active").map(r=>text(r.service_code).toLowerCase())),missing=COMMISSION_DEFAULT_SERVICES.filter(code=>!present.has(code)),seeded:Array<{serviceCode:string;termId:string}>=[],day=today();
 // Every pass first withdraws any seed draft an interrupted run left behind, for every service, so nothing ever waits for
 // approval in the seed's name (and nobody can approve one: approveServiceCommissionDefaults refuses system-made drafts).
 for(const stale of rows.filter(r=>text(r.status)==="draft"&&text(r.created_by)===DEFAULT_SEED_MAKER))await withdrawDraft(db,{termId:text(stale.id),actorId:DEFAULT_SEED_MAKER,detail:{serviceCode:text(stale.service_code),reason:"An automatic default that did not finish; replaced"}});
 if(!missing.length)return{seeded,blocked:null as string|null};
 const locked=await lockedMonthProblem(db,[day]);if(locked)return{seeded,blocked:locked};
 for(const serviceCode of missing){
  const draft=await saveCommercialTerm(db,{serviceCode,providerId:null,engagementModel:engagementModelFor("commission",serviceCode),providerSharePct:providerShareFromCommission(PAWSPACE_COMMISSION_DEFAULT_PERCENT),effectiveFrom:day,reason:SEED_REASON,actorId:DEFAULT_SEED_MAKER});
  const row=await db.prepare("SELECT * FROM provider_commercial_terms WHERE id=?").bind(draft.id).first<Row>();
  const done=row?await activateTermsTogether(db,{drafts:[row],approvalReference:DEFAULT_SEED_REFERENCE,actorId:DEFAULT_COMMISSION_SEED_APPROVER,scope:"SERVICE-DEFAULTS",detail:{serviceCode,seeded:true,ownerDecision:"C"},extraGuard:{sql:"NOT EXISTS (SELECT 1 FROM provider_commercial_terms WHERE service_code=? AND provider_id IS NULL AND status='active')",binds:[serviceCode]}}):null;
  if(done?.applied){seeded.push({serviceCode,termId:draft.id});continue;}
  await withdrawDraft(db,{termId:draft.id,actorId:DEFAULT_SEED_MAKER,detail:{serviceCode,reason:"A default was set for this service while the seed ran; that one is kept"}});
 }
 return{seeded,blocked:null as string|null};
}

/** Finance > Partners, "Default commission by service": each service's default in force today, any starting later, and changes waiting for approval. Seeds a missing default first. */
export async function serviceCommissionDefaultsView(db:Db){
 await ensureCommercialTermsTables(db);
 const seed=await seedMissingServiceCommissionDefaults(db).catch((error:unknown)=>{console.error("[service-commission-defaults] the missing service defaults could not be set",error);return{seeded:[] as Array<{serviceCode:string;termId:string}>,blocked:"The missing service defaults could not be set just now. Reload the page to try again." as string|null};});
 const rows=await defaultRows(db),day=today();
 const services=sectionServices(rows).map(code=>{const mine=rows.filter(r=>text(r.service_code).toLowerCase()===code),active=mine.filter(r=>text(r.status)==="active"),inForce=active.find(r=>text(r.effective_from)<=day);return{serviceCode:code,inForce:inForce?summary(inForce):null,scheduled:active.filter(r=>text(r.effective_from)>day).reverse().map(summary),waiting:mine.filter(r=>text(r.status)==="draft").map(summary)};});
 return{services,today:day,range:{minPercent:PAWSPACE_COMMISSION_MIN_PERCENT,maxPercent:PAWSPACE_COMMISSION_MAX_PERCENT,defaultPercent:PAWSPACE_COMMISSION_DEFAULT_PERCENT},resolutionOrder:COMMISSION_RESOLUTION_ORDER,seeded:seed.seeded,blocked:seed.blocked,waiting:services.flatMap(service=>service.waiting)};
}

/**
 * The MAKER step: propose PawSpace's default commission for one service, or the same default for every service at once.
 * 10-40%, a reason, and a start date from today (never back-dated). Nothing applies until a different person approves it.
 * A newer proposal replaces a change still waiting for the same service, so the approver sees one value per service.
 */
export async function proposeServiceCommissionDefault(db:Db,input:{serviceCode?:string|null;allServices?:boolean|null;pawspaceCommissionPercent:unknown;effectiveFrom:string;reason:string;actorId:string}){
 await ensureCommercialTermsTables(db);
 const actorId=text(input.actorId),reason=text(input.reason),effectiveFrom=text(input.effectiveFrom),all=input.allServices===true,single=text(input.serviceCode).toLowerCase().replaceAll(" ","_");
 if(!actorId)throw refuse("The person proposing the default is required");
 if(!all&&!single)throw refuse("Choose the service whose default commission you are changing, or every service");
 if(!all&&isFuneralService(single))throw refuse("Funeral and memorial are not commission services, so they have no default commission here.");
 const problem=pawspaceCommissionProblem(input.pawspaceCommissionPercent,all?"every service":serviceLabel(single));if(problem)throw refuse(problem);
 const start=serviceDefaultStartProblem(effectiveFrom,today());if(start)throw refuse(start);
 if(reason.length<8)throw refuse("A clear reason of at least 8 characters is required");
 const locked=await lockedMonthProblem(db,[effectiveFrom]);if(locked)throw refuse(locked,409);
 const rows=await defaultRows(db),codes=all?sectionServices(rows):[single],percent=Number(input.pawspaceCommissionPercent);
 for(const old of rows.filter(r=>text(r.status)==="draft"&&codes.includes(text(r.service_code).toLowerCase())))await withdrawDraft(db,{termId:text(old.id),actorId,detail:{serviceCode:text(old.service_code),replacedByNewDefaultProposal:true}});
 const drafts=[];
 for(const serviceCode of codes){
  // Only the commission changes: the service keeps its engagement model and cash rule.
  const current=rows.find(r=>text(r.status)==="active"&&text(r.service_code).toLowerCase()===serviceCode),model=(current&&RANGE_GOVERNED_MODELS.has(text(current.engagement_model))?text(current.engagement_model):engagementModelFor("commission",serviceCode)) as EngagementModel;
  const saved=await saveCommercialTerm(db,{serviceCode,providerId:null,engagementModel:model,providerSharePct:providerShareFromCommission(percent),cashAllowed:current?num(current.cash_allowed)===1:undefined,effectiveFrom,reason,actorId});
  drafts.push({termId:saved.id,serviceCode,pawspaceCommissionPercent:percent,previousPercent:current?commissionFromProviderShare(num(current.provider_share_pct)):null,effectiveFrom});
 }
 return{status:"awaiting_approval" as const,allServices:all,pawspaceCommissionPercent:percent,effectiveFrom,drafts,next:"A different person must approve this default, with an approval reference, before it applies."};
}

/**
 * The CHECKER step: a different person approves the default changes they were shown (termIds), with an approval reference.
 * Refused if any of them was replaced since, if its start date has passed (never back-dated), or if its month is locked. The
 * set applies in one guarded batch: all of it or none of it. The same approval repeated returns the first one.
 */
export async function approveServiceCommissionDefaults(db:Db,input:{termIds:unknown;approvalReference:string;actorId:string}){
 await ensureCommercialTermsTables(db);
 const ids=idList(input.termIds),approvalReference=text(input.approvalReference),actorId=text(input.actorId);
 if(!ids.length)throw refuse("Choose the default commission changes you are approving");
 if(!actorId)throw refuse("The approver is required");
 if(approvalReference.length<4)throw refuse("An approval reference is required to approve a default commission");
 const rows=(await db.prepare("SELECT * FROM provider_commercial_terms WHERE provider_id IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY service_code,version").bind(JSON.stringify(ids)).all<Row>()).results;
 if(rows.length===ids.length&&rows.every(r=>text(r.status)==="active"&&actorKey(r.approved_by)===actorKey(actorId)&&text(r.approval_reference)===approvalReference))return{status:"active" as const,activated:rows.map(summary),duplicatePrevented:true};
 if(rows.length!==ids.length||rows.some(r=>text(r.status)!=="draft"))throw refuse(CHANGED_SINCE_LOADED,409);
 // Maker-checker needs two people: a draft the system made would be approved by one person alone.
 if(rows.some(r=>isSystemActor(r.created_by)))throw refuse(SYSTEM_MADE_DRAFT,409);
 if(rows.some(r=>actorKey(r.created_by)===actorKey(actorId)))throw refuse("Maker/checker: the person who proposed a default commission cannot approve it. A second person must approve it.",409);
 const day=today();
 for(const row of rows){const code=serviceLabel(text(row.service_code)),range=providerShareRangeProblem(text(row.engagement_model),num(row.provider_share_pct),code);if(range)throw refuse(`${range} Propose it again; this one cannot be approved.`,409);if(serviceDefaultStartProblem(row.effective_from,day))throw refuse(`The ${code} default was to start on ${text(row.effective_from)}, which has passed, and a default is never back-dated. Propose it again with a start date from today.`,409);}
 const locked=await lockedMonthProblem(db,rows.map(r=>r.effective_from));if(locked)throw refuse(locked,409);
 const done=await activateTermsTogether(db,{drafts:rows,approvalReference,actorId,scope:"SERVICE-DEFAULTS",detail:{services:rows.map(r=>text(r.service_code))}});
 if(!done.applied)throw refuse(CHANGED_SINCE_LOADED,409);
 return{status:"active" as const,activated:rows.map(r=>summary({...r,status:"active",approved_by:actorId,approval_reference:approvalReference})),duplicatePrevented:false};
}

/** Turn down (or withdraw) default changes waiting for approval. Nothing about the defaults in force changes. */
export async function rejectServiceCommissionDefaults(db:Db,input:{termIds:unknown;actorId:string;note?:string|null}){
 await ensureCommercialTermsTables(db);
 const ids=idList(input.termIds),actorId=text(input.actorId),note=text(input.note)||null;
 if(!ids.length)throw refuse("Choose the default commission changes you are turning down");
 if(!actorId)throw refuse("The person turning down the change is required");
 const rows=(await db.prepare("SELECT * FROM provider_commercial_terms WHERE provider_id IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY service_code,version").bind(JSON.stringify(ids)).all<Row>()).results;
 if(rows.length===ids.length&&rows.every(r=>text(r.status)==="rejected"))return{status:"rejected" as const,rejected:ids,duplicatePrevented:true};
 if(rows.length!==ids.length||rows.some(r=>text(r.status)!=="draft"))throw refuse(CHANGED_SINCE_LOADED,409);
 // Like approval: the rejection (and its audit row) only counts if every change was still waiting when the batch ran.
 const now=Date.now(),claim=crypto.randomUUID(),reviewed=JSON.stringify(rows.map(r=>({id:text(r.id),updatedAt:num(r.updated_at)})));
 const results=await db.batch([
  db.prepare("INSERT INTO commercial_terms_audit (id,term_id,action,actor_id,detail_json,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM provider_commercial_terms t JOIN json_each(?) j ON t.id=json_extract(j.value,'$.id') AND t.updated_at=json_extract(j.value,'$.updatedAt') WHERE t.status='draft')=?").bind(claim,"SERVICE-DEFAULTS","default_change_rejected",actorId,JSON.stringify({termIds:ids,services:rows.map(r=>text(r.service_code)),note}),now,reviewed,rows.length),
  ...rows.map(row=>db.prepare("UPDATE provider_commercial_terms SET status='rejected',updated_at=? WHERE id=? AND status='draft' AND EXISTS (SELECT 1 FROM commercial_terms_audit WHERE id=?)").bind(now,text(row.id),claim)),
 ]);
 if(!changed(results[0]))throw refuse(CHANGED_SINCE_LOADED,409);
 return{status:"rejected" as const,rejected:ids,duplicatePrevented:false};
}
