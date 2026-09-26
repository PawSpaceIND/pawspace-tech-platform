/**
 * Setting a provider's engagement and commission (owner decision 8, audit G13/G14). ONE commission system:
 * provider_commercial_terms, through the existing save (maker) + activate (checker) path in
 * lib/provider-commercial-terms.ts. Used at provider onboarding/activation and on Finance > Partners.
 *
 *  - Staff choose how the provider is engaged: commission, full-time contractor or funeral / memorial vendor.
 *  - For commission they set PawSpace's commission for each service the provider offers: 10-40% of the amount
 *    paid, 30% by default (lib/commission-range.ts). The provider gets the rest. A funeral vendor gets a share
 *    of each case (GST exempt); a full-time contractor has no share (paid by Contractor pay, decision 7).
 *  - Saving drafts one term per service (the maker). A second person activates them all with an approval
 *    reference (the checker); the drafter can never activate their own. Activation also records the engagement
 *    on the provider's capacity profile and payout profile, so every reader of "is this provider full-time"
 *    agrees with the terms.
 *  - Every proposal carries the plain-English example staff saw: "On a Rs 1,000 booking: provider gets Rs 700,
 *    PawSpace keeps Rs 300 and pays Rs 54 GST", under the one GST setting.
 */
import{GovernedRefusal}from"./governed-http-error";
import{activateCommercialTerm,ensureCommercialTermsTables,pendingOrderOverrideRequests,saveCommercialTerm}from"./provider-commercial-terms";
import{PAWSPACE_COMMISSION_DEFAULT_PERCENT,PAWSPACE_COMMISSION_MAX_PERCENT,PAWSPACE_COMMISSION_MIN_PERCENT,commissionFromProviderShare,commissionPreview,engagementModelFor,engagementOfModel,engagementOfModels,providerShareFromCommission,providerShareRangeProblem,providerTermsProblems,type ProviderEngagement}from"./commission-range";
import{resolveGstPolicy}from"./gst-setting";
import{ensureProviderCommissionTables,legacyCommissionNeedingDecision,migrateLegacyCommissionProfiles}from"./provider-commission-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const refuse=(message:string,status=400)=>new GovernedRefusal(message,status);
const actorKey=(v:unknown)=>text(v).toLowerCase();
const today=()=>new Date().toISOString().slice(0,10);
const parseList=(value:unknown):string[]=>{let list:unknown=[];try{list=JSON.parse(text(value)||"[]");}catch{/* a malformed list names no service */}return Array.isArray(list)?list.map(text).filter(Boolean):[];};
/* A table nobody has created yet (a provider with no capacity or onboarding profile) is genuinely empty; any other failure throws. */
async function allRows(db:Db,sql:string,binds:unknown[]=[]){try{return(await db.prepare(sql).bind(...binds).all<Row>()).results||[];}catch(error){if(/no such table/i.test(error instanceof Error?error.message:String(error)))return[] as Row[];throw error;}}

/** The GST rule for the worked example: the all-cities setting (the owner's default, 18% of the amount, when none is set). */
async function previewGstPolicy(db:Db){const policy=await resolveGstPolicy(db,{cityId:"*"});return{ratePercent:policy.ratePercent,method:policy.method};}
const termSummary=(row:Row)=>{const model=text(row.engagement_model),share=num(row.provider_share_pct);return{termId:text(row.id),serviceCode:text(row.service_code),status:text(row.status),engagementModel:model,engagement:engagementOfModel(model),providerSharePct:share,pawspaceCommissionPercent:model==="direct_employee"?null:commissionFromProviderShare(share),effectiveFrom:text(row.effective_from),version:num(row.version),createdBy:text(row.created_by),approvedBy:text(row.approved_by)||null,approvalReference:text(row.approval_reference)||null};};

/* Terms are effective-dated: of the active terms for a service, the one in force today is the latest starting on or before
 * today; any starting later are scheduled (activated, but not yet in force). Rows must be ordered effective_from DESC. */
const isActive=(row:Row)=>text(row.status)==="active";
const inForceToday=(rows:Row[],code:string)=>{const day=today();return rows.find(r=>isActive(r)&&text(r.service_code)===code&&text(r.effective_from)<=day);};
const scheduledAfterToday=(rows:Row[],code:string)=>{const day=today();return rows.filter(r=>isActive(r)&&text(r.service_code)===code&&text(r.effective_from)>day).reverse();};

/** The services a provider offers: their capacity profile, their onboarding profile, and any term already set for them. */
export async function providerOfferedServices(db:Db,providerId:string){
 const id=text(providerId),found=new Set<string>();if(!id)return[];
 for(const row of await allRows(db,"SELECT services_json FROM provider_capacity_profiles WHERE id=?",[id]))for(const code of parseList(row.services_json))found.add(code);
 for(const row of await allRows(db,"SELECT services_json FROM provider_onboarding_profiles WHERE provider_id=?",[id]))for(const code of parseList(row.services_json))found.add(code);
 for(const row of await allRows(db,"SELECT DISTINCT service_code FROM provider_commercial_terms WHERE provider_id=?",[id]))if(text(row.service_code))found.add(text(row.service_code));
 return[...found].sort();
}

export type ProviderTermsProposal={providerId:string;engagement:ProviderEngagement|string;services:Array<{serviceCode:string;pawspaceCommissionPercent?:number|string|null}>;effectiveFrom?:string|null;reason:string;actorId:string};

/**
 * The MAKER step: draft the provider's terms, one per service, through saveCommercialTerm (which enforces the
 * same range). Nothing applies until a second person activates them. A new proposal withdraws the provider's
 * drafts still waiting, so the checker always approves one consistent set.
 */
export async function draftProviderCommercialTerms(db:Db,input:ProviderTermsProposal){
 await ensureCommercialTermsTables(db);
 const providerId=text(input.providerId),engagement=text(input.engagement),reason=text(input.reason),effectiveFrom=text(input.effectiveFrom)||today(),actorId=text(input.actorId);
 if(!providerId)throw refuse("Provider ID is required");
 if(!actorId)throw refuse("The person proposing the terms is required");
 if(reason.length<8)throw refuse("A clear reason of at least 8 characters is required");
 // Checked here, before older drafts are withdrawn, so a mistyped date cannot leave the provider with no proposal at all.
 const day=Date.parse(`${effectiveFrom}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)||Number.isNaN(day)||new Date(day).toISOString().slice(0,10)!==effectiveFrom)throw refuse("Enter the date these terms start from as a real date (YYYY-MM-DD)");
 const seen=new Set<string>(),lines:Array<{serviceCode:string;percent:number}>=[];
 for(const item of Array.isArray(input.services)?input.services:[]){const code=text(item?.serviceCode).toLowerCase();if(!code||seen.has(code))continue;seen.add(code);const raw=item.pawspaceCommissionPercent;lines.push({serviceCode:code,percent:raw===""||raw==null?PAWSPACE_COMMISSION_DEFAULT_PERCENT:Number(raw)});}
 const problems=providerTermsProblems({engagement,services:lines.map(l=>({serviceCode:l.serviceCode,pawspaceCommissionPercent:l.percent}))});
 if(problems.length)throw refuse(problems.join(" "));
 const chosen=engagement as ProviderEngagement,gstPolicy=await previewGstPolicy(db),now=Date.now();
 for(const old of await allRows(db,"SELECT id,service_code FROM provider_commercial_terms WHERE provider_id=? AND status='draft'",[providerId]))await db.batch([
  db.prepare("UPDATE provider_commercial_terms SET status='withdrawn',updated_at=? WHERE id=? AND status='draft'").bind(now,text(old.id)),
  db.prepare("INSERT INTO commercial_terms_audit (id,term_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),text(old.id),"withdrawn",actorId,JSON.stringify({providerId,serviceCode:text(old.service_code),replacedByNewProposal:true}),now),
 ]);
 const drafts=[];
 for(const line of lines){
  const model=engagementModelFor(chosen,line.serviceCode),share=model==="direct_employee"?0:providerShareFromCommission(line.percent);
  const saved=await saveCommercialTerm(db,{serviceCode:line.serviceCode,providerId,engagementModel:model,providerSharePct:share,effectiveFrom,reason,actorId});
  drafts.push({termId:saved.id,serviceCode:line.serviceCode,engagementModel:model,providerSharePct:share,pawspaceCommissionPercent:model==="direct_employee"?null:line.percent,version:saved.version,preview:commissionPreview({engagement:model==="funeral_exempt"?"funeral_vendor":chosen,pawspaceCommissionPercent:line.percent,gstPolicy,serviceCode:line.serviceCode})});
 }
 return{providerId,engagement:chosen,effectiveFrom,status:"awaiting_approval" as const,drafts,next:"A second person must approve these terms, with an approval reference, before they apply."};
}

/** Record the engagement where the rest of the platform reads it: the capacity profile and the payout profile. */
async function recordProviderEngagement(db:Db,input:{providerId:string;engagement:ProviderEngagement;actorId:string}){
 const model=input.engagement==="full_time"?"full_time":"commission",now=Date.now(),recorded:string[]=[];
 const capacity=await db.prepare("UPDATE provider_capacity_profiles SET provider_model=?,contract_type=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND (COALESCE(provider_model,'')<>? OR COALESCE(contract_type,'')<>?)").bind(model,model,input.actorId,now,input.providerId,model,model).run().catch(()=>db.prepare("UPDATE provider_capacity_profiles SET provider_model=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND COALESCE(provider_model,'')<>?").bind(model,input.actorId,now,input.providerId,model).run()).catch(()=>null);
 if(Number(capacity?.meta?.changes??0)>0)recorded.push("capacity_profile");
 await ensureProviderCommissionTables(db);
 await db.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,status,reason,updated_by,created_at,updated_at) VALUES (?,?,'active',?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET engagement_model=excluded.engagement_model,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(input.providerId,model,"Engagement set by approved commercial terms",input.actorId,now,now).run();
 recorded.push("payout_profile");
 return{providerModel:model,recorded};
}

/**
 * The CHECKER step: a second person activates every draft for the provider, with an approval reference. `termIds` are the
 * drafts the checker was shown (the screens always send them): if the proposal was replaced or added to since, nothing
 * is activated and the checker must review the new one - approving is always approving what was seen.
 */
export async function activateProviderCommercialTerms(db:Db,input:{providerId:string;approvalReference:string;actorId:string;termIds?:ReadonlyArray<unknown>|null}){
 await ensureCommercialTermsTables(db);
 const providerId=text(input.providerId),approvalReference=text(input.approvalReference),actorId=text(input.actorId);
 if(!providerId)throw refuse("Provider ID is required");
 if(approvalReference.length<4)throw refuse("An approval reference is required to activate commercial terms");
 const drafts=await allRows(db,"SELECT * FROM provider_commercial_terms WHERE provider_id=? AND status='draft' ORDER BY service_code,version",[providerId]);
 if(!drafts.length)throw refuse("Nothing is waiting for approval for this provider",404);
 if(drafts.some(d=>actorKey(d.created_by)===actorKey(actorId)))throw refuse("Maker/checker: the drafter cannot activate their own commercial term. A second person must approve these terms.",409);
 if(Array.isArray(input.termIds)){const seen=new Set(input.termIds.map(text).filter(Boolean)),waiting=drafts.map(d=>text(d.id));if(seen.size!==waiting.length||waiting.some(id=>!seen.has(id)))throw refuse("The terms waiting for approval changed after you loaded them. Reload this provider, check the new proposal and approve again.",409);}
 // All or nothing: a draft outside the range (saved before it existed) stops the whole set before any of it applies.
 const outside=drafts.map(d=>providerShareRangeProblem(text(d.engagement_model),num(d.provider_share_pct),text(d.service_code))).filter(Boolean);
 if(outside.length)throw refuse(`${outside.join(" ")} Propose these terms again; they cannot be activated.`,409);
 const activated=[];
 for(const draft of drafts){await activateCommercialTerm(db,{termId:text(draft.id),approvalReference,actorId});activated.push({...termSummary({...draft,status:"active",approved_by:actorId,approval_reference:approvalReference})});}
 const engagement=engagementOfModels(drafts.map(d=>text(d.engagement_model)))??"commission",recorded=await recordProviderEngagement(db,{providerId,engagement,actorId});
 return{providerId,engagement,status:"active" as const,activated,engagementRecorded:recorded};
}

/** One provider's terms for the screens: each service with its active term, any draft waiting, and the service default. */
export async function providerCommercialTermsView(db:Db,input:{providerId:string}){
 await ensureCommercialTermsTables(db);await migrateLegacyCommissionProfiles(db).catch(()=>null);
 const providerId=text(input.providerId);if(!providerId)throw refuse("Provider ID is required");
 const[terms,defaults,offered,gstPolicy,capacity,legacy]=await Promise.all([allRows(db,"SELECT * FROM provider_commercial_terms WHERE provider_id=? AND status IN ('active','draft') ORDER BY service_code,effective_from DESC,version DESC",[providerId]),allRows(db,"SELECT * FROM provider_commercial_terms WHERE provider_id IS NULL AND status='active' ORDER BY service_code,effective_from DESC,version DESC"),providerOfferedServices(db,providerId),previewGstPolicy(db),allRows(db,"SELECT provider_model FROM provider_capacity_profiles WHERE id=?",[providerId]),legacyCommissionNeedingDecision(db)]);
 const codes=[...new Set([...offered,...terms.map(r=>text(r.service_code))])].sort();
 // "active" is the term in force today; "scheduled" are activated terms that start later (earliest first).
 const services=codes.map(code=>{const active=inForceToday(terms,code),draft=terms.find(r=>text(r.status)==="draft"&&text(r.service_code)===code),standard=inForceToday(defaults,code)??defaults.find(r=>text(r.service_code)===code);return{serviceCode:code,active:active?termSummary(active):null,scheduled:scheduledAfterToday(terms,code).map(termSummary),draft:draft?termSummary(draft):null,serviceDefault:standard?termSummary(standard):null};});
 const modelsOf=(rows:Row[])=>rows.map(t=>text(t.engagement_model));
 const engagement:ProviderEngagement=engagementOfModels(modelsOf(terms.filter(t=>text(t.status)==="draft")))??engagementOfModels(modelsOf(terms.filter(isActive)))??(text(capacity[0]?.provider_model)==="full_time"?"full_time":"commission");
 const waiting=terms.filter(t=>text(t.status)==="draft").map(termSummary);
 return{providerId,engagement,services,awaitingApproval:waiting,proposedBy:[...new Set(waiting.map(w=>w.createdBy))],gstPolicy,range:{minPercent:PAWSPACE_COMMISSION_MIN_PERCENT,maxPercent:PAWSPACE_COMMISSION_MAX_PERCENT,defaultPercent:PAWSPACE_COMMISSION_DEFAULT_PERCENT},legacyCommission:legacy.find(l=>l.providerId===providerId)??null};
}

/** Everything Finance > Partners shows about commission: provider terms, drafts waiting, order overrides waiting, and older settings that need a decision. */
export async function commercialTermsOverview(db:Db){
 await ensureCommercialTermsTables(db);await migrateLegacyCommissionProfiles(db).catch(()=>null);
 const[terms,defaults,gstPolicy,overrideRequests,legacy]=await Promise.all([allRows(db,"SELECT * FROM provider_commercial_terms WHERE provider_id IS NOT NULL AND status IN ('active','draft') ORDER BY provider_id,service_code,effective_from DESC,version DESC LIMIT 500"),allRows(db,"SELECT * FROM provider_commercial_terms WHERE provider_id IS NULL AND status='active' ORDER BY service_code,effective_from DESC,version DESC"),previewGstPolicy(db),pendingOrderOverrideRequests(db),legacyCommissionNeedingDecision(db)]);
 const providers=new Map<string,{providerId:string;engagement:ProviderEngagement|null;terms:ReturnType<typeof termSummary>[]}>();
 // Per provider and service: the newest draft, and every active term (the one in force today and any scheduled to start later).
 for(const row of terms){const id=text(row.provider_id),entry=providers.get(id)??{providerId:id,engagement:null,terms:[]};const summary=termSummary(row);if(!entry.terms.some(t=>t.serviceCode===summary.serviceCode&&t.status===summary.status&&(summary.status!=="active"||t.effectiveFrom===summary.effectiveFrom)))entry.terms.push(summary);providers.set(id,entry);}
 for(const entry of providers.values())entry.engagement=engagementOfModels(entry.terms.map(t=>t.engagementModel));
 const serviceDefaults:ReturnType<typeof termSummary>[]=[];for(const code of new Set(defaults.map(r=>text(r.service_code)))){const row=inForceToday(defaults,code)??defaults.find(r=>text(r.service_code)===code);if(row)serviceDefaults.push(termSummary(row));}/* the default in force today, else the one scheduled */
 return{range:{minPercent:PAWSPACE_COMMISSION_MIN_PERCENT,maxPercent:PAWSPACE_COMMISSION_MAX_PERCENT,defaultPercent:PAWSPACE_COMMISSION_DEFAULT_PERCENT},gstPolicy,example:commissionPreview({engagement:"commission",pawspaceCommissionPercent:PAWSPACE_COMMISSION_DEFAULT_PERCENT,gstPolicy}).sentence,providers:[...providers.values()],awaitingApproval:[...providers.values()].filter(p=>p.terms.some(t=>t.status==="draft")).map(p=>({providerId:p.providerId,proposedBy:[...new Set(p.terms.filter(t=>t.status==="draft").map(t=>t.createdBy))],services:p.terms.filter(t=>t.status==="draft")})),serviceDefaults,overrideRequests,legacyNeedsDecision:legacy};
}
