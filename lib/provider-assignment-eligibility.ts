import{INVALID_VERIFICATION_STATUSES,ensureVerificationMandateTables}from"./provider-verification-mandate";
import{resolveProviderVerificationPolicy,seedApprovedVerificationPolicies}from"./provider-verification-policy";
import{ensureProviderCapacityTables}from"./provider-capacity-governance";
import{uatRosterSeedingEnabled}from"./scheduling-roster-authority";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export type AssignmentBlock={
  blocked:boolean;
  providerId:string;
  reasons:string[];
  outstanding:Array<{verificationType:string;state:string;expiresAt:number|null}>;
  policyVersion:string|null;
  evaluated:boolean;
};

const allow=(providerId:string,reason:string,policyVersion:string|null=null):AssignmentBlock=>({blocked:false,providerId,reasons:[reason],outstanding:[],policyVersion,evaluated:true});
const block=(providerId:string,reason:string,policyVersion:string|null=null,outstanding:AssignmentBlock["outstanding"]=[]):AssignmentBlock=>({blocked:true,providerId,reasons:[reason],outstanding,policyVersion,evaluated:true});

async function runtimeEnv():Promise<Record<string,unknown>>{
  try{const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}catch{return{};}
}

/**
 * The only missing-record exemption: a capacity row written by the repository's seed function AND an
 * explicitly declared UAT scheduling runtime. Production configuration forbids PAWSPACE_SCHEDULING_ENV,
 * so the seed provenance marker alone can never unlock this path in production.
 */
async function governedUatSeedFixture(db:Db,providerId:string){
  const env=await runtimeEnv();
  const explicitTest=typeof process!=="undefined"&&process.env?.NODE_ENV==="test"&&process.env?.PAWSPACE_LOCAL_PREVIEW==="on";
  if(!uatRosterSeedingEnabled(env)&&!explicitTest)return false;
  const profile=await db.prepare("SELECT updated_by FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  return text(profile?.updated_by)==="founder_seed";
}

/** A provider may receive NEW work only when current mandatory verification can be proved. */
export async function providerAssignmentBlock(db:Db,providerId:string,at=Date.now()):Promise<AssignmentBlock>{
  const id=text(providerId);
  if(!id)return block(id,"no_provider");
  try{
    await ensureVerificationMandateTables(db);
    const application=await db.prepare("SELECT id,vertical_key FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1").bind(id).first<Row>()
      .catch((error:unknown)=>{if(/no such table/i.test(error instanceof Error?error.message:String(error)))return null;throw error;});
    if(!application){
      if(await governedUatSeedFixture(db,id))return allow(id,"uat_seed_fixture_exemption");
      return block(id,"no_onboarding_verification_record");
    }

    const profile=await db.prepare("SELECT city_id FROM provider_capacity_profiles WHERE id=?").bind(id).first<Row>();
    await seedApprovedVerificationPolicies(db);
    const policy=await resolveProviderVerificationPolicy(db,text(application.vertical_key),text(profile?.city_id)||null);
    if(!policy||policy.config.configured!==true)return block(id,"verification_policy_unavailable",policy?.policyVersion??null);

    const required=policy.config.requiredTypes.map(String).map(text).filter(Boolean);
    if(!required.length)return allow(id,"no_mandatory_verifications",policy.policyVersion);

    const rows=await db.prepare("SELECT verification_type,status,expires_at FROM provider_verifications WHERE application_id=?").bind(text(application.id)).all<Row>();
    const byType=new Map(rows.results.map(row=>[text(row.verification_type),{status:text(row.status),expiresAt:row.expires_at===null||row.expires_at===undefined?null:Number(row.expires_at)}]));
    const outstanding:AssignmentBlock["outstanding"]=[];
    for(const type of required){
      const record=byType.get(type);
      if(!record){outstanding.push({verificationType:type,state:"not_started",expiresAt:null});continue;}
      if(record.status!=="verified"){
        outstanding.push({verificationType:type,state:INVALID_VERIFICATION_STATUSES.includes(record.status)?record.status:"not_verified",expiresAt:record.expiresAt});
        continue;
      }
      if(record.expiresAt!==null&&(!Number.isFinite(record.expiresAt)||record.expiresAt<=at)){
        outstanding.push({verificationType:type,state:"expired",expiresAt:record.expiresAt});
      }
    }
    return outstanding.length
      ?block(id,"mandatory_verification_not_current",policy.policyVersion,outstanding)
      :allow(id,"all_mandatory_verifications_current",policy.policyVersion);
  }catch{
    return block(id,"verification_evaluation_error");
  }
}

/** Refuses the write when mandatory verification is missing, stale, unknown or could not be evaluated. */
export async function assertProviderAssignable(db:Db,providerId:string,at=Date.now()){
  const verdict=await providerAssignmentBlock(db,providerId,at);
  if(verdict.blocked){
    throw Response.json({error:"This provider cannot take new work until their mandatory verification is current",
      code:"provider_verification_not_current",providerId:verdict.providerId,reasons:verdict.reasons,
      outstanding:verdict.outstanding,policyVersion:verdict.policyVersion},{status:409});
  }
  return verdict;
}

/** Matching is fail-closed too: an evaluation exception never leaves a provider in the candidate set. */
export async function filterAssignableProviders<T extends{id:string}>(db:Db,providers:T[],at=Date.now()){
  const verdicts=await Promise.all(providers.map(async provider=>{
    try{return await providerAssignmentBlock(db,provider.id,at);}catch{return block(text(provider.id),"verification_evaluation_error");}
  }));
  return providers.filter((_,index)=>verdicts[index]?.blocked===false);
}

export type RevocationOutcome={providerId:string;verificationType:string;removedFromMatching:boolean;recoveryCases:number;preserved:{bookings:number;reservations:number}};

export async function revokeProviderVerification(db:Db,input:{providerId:string;verificationType:string;reason:string;actorId:string;now?:number}):Promise<RevocationOutcome>{
  const{recordVerificationValidity}=await import("./provider-verification-mandate");
  await ensureProviderCapacityTables(db);
  const providerId=text(input.providerId),now=input.now??Date.now();
  const application=await db.prepare("SELECT id FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1").bind(providerId).first<Row>().catch(()=>null);
  if(application)await recordVerificationValidity(db,{applicationId:text(application.id),verificationType:input.verificationType,status:"revoked",expiresAt:now,actorId:input.actorId,note:input.reason});

  await db.prepare("UPDATE provider_capacity_profiles SET live=0,status='verification_hold',version=version+1,updated_by=?,updated_at=? WHERE id=?")
    .bind(input.actorId,now,providerId).run().catch(()=>null);

  const openCase=async(row:{groupId:string;bookingId:string|null;phase:string})=>{
    const existing=await db.prepare("SELECT id FROM provider_recovery_cases WHERE failed_provider_id=? AND group_id=? AND status='open'").bind(providerId,row.groupId).first<Row>().catch(()=>null);
    if(existing)return false;
    await db.prepare("INSERT INTO provider_recovery_cases (id,group_id,booking_id,failed_provider_id,reason_code,status,detail_json,opened_at,updated_at) VALUES (?,?,?,?,?,'open',?,?,?)")
      .bind(`PRC-${crypto.randomUUID().slice(0,10).toUpperCase()}`,row.groupId,row.bookingId,providerId,"provider_verification_revoked",
        JSON.stringify({verificationType:input.verificationType,reason:input.reason,phase:row.phase,actorId:input.actorId,workPreserved:true}),now,now).run();
    return true;
  };

  let cases=0,reservations=0,bookings=0;
  const held=await db.prepare("SELECT group_id,scheduled_start,status FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled'").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]}));
  for(const row of held.results){
    reservations+=1;
    const started=new Date(text(row.scheduled_start)).getTime()<=now;
    if(await openCase({groupId:text(row.group_id),bookingId:null,phase:started?"in_progress":"scheduled_not_started"}))cases+=1;
  }
  const active=await db.prepare("SELECT id,schedule_group_id,status FROM canonical_bookings WHERE provider_id=? AND status NOT IN ('cancelled','completed','refunded')").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]}));
  for(const row of active.results){
    bookings+=1;
    if(await openCase({groupId:text(row.schedule_group_id)||text(row.id),bookingId:text(row.id),phase:text(row.status)}))cases+=1;
  }
  return{providerId,verificationType:input.verificationType,removedFromMatching:true,recoveryCases:cases,preserved:{bookings,reservations}};
}

export async function clearProviderVerificationHold(db:Db,input:{providerId:string;actorId:string;reason:string;now?:number}){
  await ensureProviderCapacityTables(db);
  const providerId=text(input.providerId),now=input.now??Date.now();
  if(!text(input.reason)||text(input.reason).length<5)throw Response.json({error:"A clear reason is required to lift a verification hold"},{status:400});
  const verdict=await providerAssignmentBlock(db,providerId,now);
  if(verdict.blocked){
    throw Response.json({error:"This provider's mandatory verification is still not current, so the hold cannot be lifted",
      code:"provider_verification_not_current",providerId,reasons:verdict.reasons,outstanding:verdict.outstanding},{status:409});
  }
  const profile=await db.prepare("SELECT status FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  if(!profile)throw Response.json({error:"Provider capacity profile not found"},{status:404});
  if(text(profile.status)!=="verification_hold")throw Response.json({error:`This provider is not on a verification hold (status ${text(profile.status)})`},{status:409});
  await db.prepare("UPDATE provider_capacity_profiles SET status='uat_ready',version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='verification_hold'")
    .bind(input.actorId,now,providerId).run();
  await db.prepare("UPDATE provider_recovery_cases SET status='resolved',resolved_at=?,updated_at=? WHERE failed_provider_id=? AND reason_code='provider_verification_revoked' AND status='open'")
    .bind(now,now,providerId).run().catch(()=>null);
  return{providerId,status:"uat_ready",live:0,readyToRemap:true};
}

export type VerificationLaunchBlocker={providerId:string;providerName:string;cityId:string;services:string[];reason:string;outstanding:Array<{verificationType:string;state:string}>};

export async function providerVerificationLaunchBlockers(db:Db,at=Date.now()):Promise<VerificationLaunchBlocker[]>{
  await ensureProviderCapacityTables(db);
  const rows=await db.prepare("SELECT id,name,city_id,services_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all<Row>();
  const blockers:VerificationLaunchBlocker[]=[];
  for(const row of rows.results){
    const providerId=text(row.id);
    const verdict=await providerAssignmentBlock(db,providerId,at);
    let services:string[]=[];
    try{services=JSON.parse(text(row.services_json)||"[]") as string[];}catch{services=[];}
    if(verdict.blocked){
      blockers.push({providerId,providerName:text(row.name),cityId:text(row.city_id),services,
        reason:verdict.reasons.includes("no_onboarding_verification_record")
          ?"This provider is live to customers but has no onboarding verification record. Onboard and verify them before launch."
          :`This provider is live to customers but compliance cannot be confirmed: ${verdict.reasons.join(", ")}.`,
        outstanding:verdict.outstanding.map(item=>({verificationType:item.verificationType,state:item.state}))});
    }
  }
  return blockers;
}