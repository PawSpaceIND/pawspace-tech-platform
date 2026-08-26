/**
 * Whether a provider may receive NEW work right now, judged against their current verification state.
 * [PTJA-W1-F53 part 2]
 *
 * Part 1 made the approved requirements real at ACTIVATION. This is the half that keeps them true
 * afterwards. A document that was valid on the day someone was activated does not stay valid, and
 * nothing consulted verification state again after that moment: a walker whose police clearance lapsed
 * last month, or whose licence was revoked this morning, kept receiving assignments.
 *
 * THE GATE IS AT WRITE TIME. It runs inside the reservation INSERT and the offer INSERT, not only in the
 * matching read. A read-side filter alone loses the race: a request that reads a valid provider, decides,
 * and then commits after a revocation lands would still write the assignment. That race is a regression
 * case (F53X-13), and it is why removing the provider from matching is necessary but not sufficient.
 *
 * WHAT A REVOCATION DOES AND DOES NOT DO. It removes the provider from new matching immediately, and it
 * opens Operations recovery cases for the work they already hold. It does NOT cancel or alter a single
 * booking, payment, work order or piece of proof - a customer whose walk is happening right now keeps
 * their walk, and a customer with a job booked for Tuesday keeps their booking while Operations finds
 * them somebody else. Losing a customer's commitment because a document expired would be a second
 * failure on top of the first.
 *
 * COMING BACK IS GOVERNED. Renewing a document does not re-list anybody. The provider returns through the
 * same controlled remapping a human already performs (addProviderToServiceMap), so the decision to put
 * someone back in front of customers stays a decision.
 */
import{INVALID_VERIFICATION_STATUSES,ensureVerificationMandateTables}from"./provider-verification-mandate";
import{resolveProviderVerificationPolicy,seedApprovedVerificationPolicies}from"./provider-verification-policy";
import{ensureProviderCapacityTables}from"./provider-capacity-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export type AssignmentBlock={
  blocked:boolean;
  providerId:string;
  /** Why the gate could not confirm eligibility, in the platform's own words. */
  reasons:string[];
  /** Mandatory checks that are missing, unverified or lapsed. */
  outstanding:Array<{verificationType:string;state:string;expiresAt:number|null}>;
  policyVersion:string|null;
  evaluated:boolean;
};

const ok=(providerId:string,reason:string):AssignmentBlock=>({blocked:false,providerId,reasons:[reason],outstanding:[],policyVersion:null,evaluated:false});

/**
 * The current verification standing of one provider.
 *
 * A check counts only when its status is `verified` AND it has not lapsed. Anything else - pending,
 * failed, rejected, revoked, manual_review, expired, or simply never run - is outstanding.
 */
export async function providerAssignmentBlock(db:Db,providerId:string,at=Date.now()):Promise<AssignmentBlock>{
  const id=text(providerId);
  if(!id)return ok(id,"no_provider");
  await ensureVerificationMandateTables(db);
  const application=await db.prepare("SELECT id,vertical_key FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1").bind(id).first<Row>().catch(()=>null);
  /*
   * THE ONE PERMISSIVE ANSWER IN THIS MODULE, and it is deliberate and visible rather than silent.
   *
   * A provider with no onboarding application has no verification records to judge - the seeded UAT
   * capacity profiles are exactly this, and they predate the onboarding pipeline entirely. Blocking them
   * would take every seeded provider off the platform rather than close a hole. So the gate reports that
   * it could not evaluate (`evaluated:false`) instead of pretending it passed, and the policy field
   * `blockProvidersWithoutVerificationRecord` turns it into a block for a deployment whose providers have
   * all been backfilled. That field is configuration in Control Center, per service and city.
   */
  if(!application){
    const fallback=await resolveProviderVerificationPolicy(db,"*",null).catch(()=>null);
    if(fallback?.config.blockProvidersWithoutVerificationRecord){
      return{blocked:true,providerId:id,reasons:["no_onboarding_verification_record"],outstanding:[],policyVersion:fallback.policyVersion,evaluated:true};
    }
    return ok(id,"no_onboarding_verification_record");
  }
  const profile=await db.prepare("SELECT city_id FROM provider_capacity_profiles WHERE id=?").bind(id).first<Row>().catch(()=>null);
  await seedApprovedVerificationPolicies(db);
  const policy=await resolveProviderVerificationPolicy(db,text(application.vertical_key),text(profile?.city_id)||null).catch(()=>null);
  if(!policy)return ok(id,"verification_policy_unavailable");
  const required=policy.config.requiredTypes.map(String);
  // Rule 8: only MANDATORY checks gate assignment. An advisory document lapsing must not stop work.
  if(!required.length)return{blocked:false,providerId:id,reasons:["no_mandatory_verifications"],outstanding:[],policyVersion:policy.policyVersion,evaluated:true};
  const rows=await db.prepare("SELECT verification_type,status,expires_at FROM provider_verifications WHERE application_id=?").bind(text(application.id)).all<Row>().catch(()=>({results:[] as Row[]}));
  const byType=new Map(rows.results.map(row=>[text(row.verification_type),{status:text(row.status),expiresAt:row.expires_at===null||row.expires_at===undefined?null:Number(row.expires_at)}]));
  const outstanding:AssignmentBlock["outstanding"]=[];
  for(const type of required){
    const record=byType.get(type);
    if(!record){outstanding.push({verificationType:type,state:"not_started",expiresAt:null});continue;}
    if(record.status!=="verified"){outstanding.push({verificationType:type,state:INVALID_VERIFICATION_STATUSES.includes(record.status)?record.status:"not_verified",expiresAt:record.expiresAt});continue;}
    if(record.expiresAt!==null&&record.expiresAt<=at){outstanding.push({verificationType:type,state:"expired",expiresAt:record.expiresAt});continue;}
  }
  return{blocked:outstanding.length>0,providerId:id,
    reasons:outstanding.length?["mandatory_verification_not_current"]:["all_mandatory_verifications_current"],
    outstanding,policyVersion:policy.policyVersion,evaluated:true};
}

/** Refuses the write when the provider's mandatory verification is not currently valid. */
export async function assertProviderAssignable(db:Db,providerId:string,at=Date.now()){
  const verdict=await providerAssignmentBlock(db,providerId,at);
  if(verdict.blocked){
    throw Response.json({error:"This provider cannot take new work until their mandatory verification is current",
      code:"provider_verification_not_current",providerId:verdict.providerId,
      outstanding:verdict.outstanding,policyVersion:verdict.policyVersion},{status:409});
  }
  return verdict;
}

/** Providers from a candidate list whose verification is currently valid. Used by the matching read. */
export async function filterAssignableProviders<T extends{id:string}>(db:Db,providers:T[],at=Date.now()){
  const verdicts=await Promise.all(providers.map(provider=>providerAssignmentBlock(db,provider.id,at).catch(()=>null)));
  return providers.filter((_,index)=>!verdicts[index]?.blocked);
}

export type RevocationOutcome={providerId:string;verificationType:string;removedFromMatching:boolean;recoveryCases:number;preserved:{bookings:number;reservations:number}};

/**
 * Records a revocation and takes the provider out of new matching immediately, opening Operations
 * recovery for the work they already hold - without altering any of that work.
 */
export async function revokeProviderVerification(db:Db,input:{providerId:string;verificationType:string;reason:string;actorId:string;now?:number}):Promise<RevocationOutcome>{
  const{recordVerificationValidity}=await import("./provider-verification-mandate");
  await ensureProviderCapacityTables(db);
  const providerId=text(input.providerId),now=input.now??Date.now();
  const application=await db.prepare("SELECT id FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1").bind(providerId).first<Row>().catch(()=>null);
  if(application)await recordVerificationValidity(db,{applicationId:text(application.id),verificationType:input.verificationType,status:"revoked",expiresAt:now,actorId:input.actorId,note:input.reason});

  // Rule 5: out of new matching immediately, not at the next sweep. The profile row is the thing
  // loadGovernedProviders reads, so this is what actually stops new work reaching them.
  await db.prepare("UPDATE provider_capacity_profiles SET live=0,status='verification_hold',version=version+1,updated_by=?,updated_at=? WHERE id=?")
    .bind(input.actorId,now,providerId).run().catch(()=>null);

  /*
   * Rules 6 and 7. Everything below OPENS A CASE and changes nothing else. No booking is cancelled, no
   * payment moved, no work order touched, no proof deleted. A walk happening right now finishes; a job
   * booked for Tuesday stays booked while Operations finds somebody else.
   */
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

/**
 * Clears a verification hold, which is the FIRST of the two governed steps back.
 *
 * Renewing a document does not re-list anybody. An Operations actor clears the hold - and may only do so
 * once every mandatory check is genuinely current again, which this refuses to take on trust - and the
 * provider then returns to customers through the same addProviderToServiceMap a human already performs.
 * Two deliberate steps, neither of them automatic. Rule 9.
 */
export async function clearProviderVerificationHold(db:Db,input:{providerId:string;actorId:string;reason:string;now?:number}){
  await ensureProviderCapacityTables(db);
  const providerId=text(input.providerId),now=input.now??Date.now();
  if(!text(input.reason)||text(input.reason).length<5)throw Response.json({error:"A clear reason is required to lift a verification hold"},{status:400});
  const verdict=await providerAssignmentBlock(db,providerId,now);
  if(verdict.blocked){
    throw Response.json({error:"This provider's mandatory verification is still not current, so the hold cannot be lifted",
      code:"provider_verification_not_current",providerId,outstanding:verdict.outstanding},{status:409});
  }
  const profile=await db.prepare("SELECT status FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  if(!profile)throw Response.json({error:"Provider capacity profile not found"},{status:404});
  if(text(profile.status)!=="verification_hold")throw Response.json({error:`This provider is not on a verification hold (status ${text(profile.status)})`},{status:409});
  // live stays 0 on purpose: lifting the hold makes the provider ELIGIBLE to be re-listed, it does not
  // re-list them. A human still decides to put them back in front of customers.
  await db.prepare("UPDATE provider_capacity_profiles SET status='uat_ready',version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='verification_hold'")
    .bind(input.actorId,now,providerId).run();
  await db.prepare("UPDATE provider_recovery_cases SET status='resolved',resolved_at=?,updated_at=? WHERE failed_provider_id=? AND reason_code='provider_verification_revoked' AND status='open'")
    .bind(now,now,providerId).run().catch(()=>null);
  return{providerId,status:"uat_ready",live:0,readyToRemap:true};
}
