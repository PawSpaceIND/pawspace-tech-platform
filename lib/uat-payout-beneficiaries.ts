/*
 * UAT ONLY: payout beneficiaries for the seeded roster. [Owner decision, 27 Sept 2026: payouts must be testable
 * end to end on staging - queue -> Release -> Send TEST payout -> RazorpayX TEST webhook -> processed.]
 *
 * The staging seeds create the UAT roster (provider_capacity_profiles, updated_by founder_seed) but no payout
 * beneficiary for it: no provider_compensation_profiles row with RazorpayX TEST bindings, no onboarding application
 * and no verified bank_kyc. lib/payout-beneficiary-verification.ts needs all three, so every seeded groomer's payout
 * sat in the Finance queue behind "No verified bank account for this provider" and nothing could be tested.
 *
 * On a declared UAT runtime whose RazorpayX is TEST-only (uatPayoutBeneficiaryGate) the missing records are seeded
 * from the RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX Worker secret, the way releaseAbandonedUatCheckouts
 * (lib/scheduling-reservation-leases.ts) frees groomers held by abandoned checkouts: only for ids the UAT roster SQL
 * and the runtime founder_seed defaults create (isUatRosterProviderId), idempotently, with seed provenance, never
 * over a person's own bank details, and with one onboarding event per provider healed. Every other runtime is a
 * no-op that writes nothing, so production never reaches a write here.
 *
 * The map is a secret. Its ids are written to the beneficiary rows the payout needs and nowhere else: never logged,
 * never in an event detail, never in a response. Readiness reports booleans and problem sentences only.
 *
 * The seeded onboarding application carries vertical_key 'uat_payout_seed' so lib/provider-assignment-eligibility.ts
 * keeps treating the groomer as the roster fixture it is (no real onboarding record), instead of holding it to the
 * grooming identity mandate it was never taken through.
 */
import{assertActiveVerifiedPayoutBeneficiary}from"./payout-beneficiary-verification";
import{ensureProviderCommissionTables}from"./provider-commission-governance";
import{ensureProviderOnboardingTransactional}from"./provider-onboarding-transactional";
import{ensureVerificationMandateTables}from"./provider-verification-mandate";
import{isUatRosterProviderId,UAT_PAYOUT_SEED_VERTICAL}from"./provider-assignment-eligibility";
import{razorpayXSandboxReadiness}from"./razorpayx-client";
import{uatRosterSeedingEnabled}from"./scheduling-roster-authority";

type Db=D1Database;type Env=Record<string,unknown>|null|undefined;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const changes=(result:unknown)=>Number((result as {meta?:{changes?:number}}|undefined)?.meta?.changes||0);
/** Who the seeded rows say wrote them: the same provenance the UAT roster SQL uses. */
export const UAT_SEED_ACTOR="founder_seed";
/** The RazorpayX contact id written when the map names none: the payout API only needs the fund account. */
export const UAT_SEED_CONTACT_ID="cont_uat_seed";
export const UAT_PAYOUT_SEED_STATUS="uat_payout_seed";
/** The runtime founder_seed groomers, which have no uatcap_ row of their own. */
export const UAT_DEFAULT_GROOMER_IDS=["groom_arun","groom_kiran","groom_sanjay"] as const;
const SEED_REASON="UAT staging payout beneficiary seed (RazorpayX TEST, no live money)";
const SEED_NOTE="Seeded on staging so the payout beneficiary check passes; not a real onboarding or bank KYC";
const FUND_ACCOUNT=/^fa_[A-Za-z0-9]+$/,CONTACT=/^cont_[A-Za-z0-9]+$/;
/** Rows a seed or a system job wrote. Anything else (an email, a staff id) is a person, whose rows are never touched. */
const SEED_PROVENANCE=/^(founder_seed|uat_demo_seed|system_seed|system:[a-z0-9_.-]+)$/i;
const isPerson=(provenance:string)=>provenance.length>0&&!SEED_PROVENANCE.test(provenance);

/**
 * True only on a declared UAT runtime (PAWSPACE_SCHEDULING_ENV=uat, as the roster seeder requires) whose RazorpayX is
 * the TEST one (sandbox, PAWSPACE_RAZORPAYX_LIVE_APPROVED exactly "false" as the readiness check demands, rzp_test_ key)
 * and which is not the production deployment. Never throws.
 */
export function uatPayoutBeneficiaryGate(env:Env){
 try{
  const runtime=env??{};
  return uatRosterSeedingEnabled(runtime)&&text(runtime.PAWSPACE_RAZORPAYX_ENV).toLowerCase()==="sandbox"&&text(runtime.PAWSPACE_RAZORPAYX_LIVE_APPROVED).toLowerCase()==="false"&&text(runtime.RAZORPAYX_KEY_ID_SANDBOX).startsWith("rzp_test_")&&text(runtime.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()!=="production";
 }catch{return false;}
}

export type UatFundAccountMap={fundAccounts:string[];contacts:string[];byProvider:Record<string,{fundAccountId:string|null;contactId:string|null}>};
/**
 * The same tolerant reading as scripts/e2e/razorpayx-sandbox.mjs: a JSON object or array, or whitespace/comma/semicolon
 * separated tokens; fa_ ids and, when present, cont_ ids. A JSON object whose keys are provider ids maps each provider
 * to the ids found under its key. Never throws; an unreadable map is an empty one.
 */
export function parseUatFundAccountMap(raw:unknown):UatFundAccountMap{
 const value=text(raw),fundAccounts=new Set<string>(),contacts=new Set<string>(),byProvider:UatFundAccountMap["byProvider"]={};
 const visit=(candidate:unknown,into?:{fa:string[];cont:string[]})=>{
  if(typeof candidate==="string"){const token=candidate.trim();if(FUND_ACCOUNT.test(token)){fundAccounts.add(token);into?.fa.push(token);}else if(CONTACT.test(token)){contacts.add(token);into?.cont.push(token);}return;}
  if(Array.isArray(candidate)){for(const item of candidate)visit(item,into);return;}
  if(candidate&&typeof candidate==="object")for(const item of Object.values(candidate as Record<string,unknown>))visit(item,into);
 };
 const done=()=>({fundAccounts:[...fundAccounts],contacts:[...contacts],byProvider});
 if(!value)return done();
 let parsed:unknown;try{parsed=JSON.parse(value);}catch{parsed=undefined;}
 if(parsed===undefined){for(const token of value.split(/[\s,;]+/))visit(token);return done();}
 if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)){
  for(const[key,item]of Object.entries(parsed as Record<string,unknown>)){const found={fa:[] as string[],cont:[] as string[]};visit(item,found);const provider=key.trim();if(provider&&!FUND_ACCOUNT.test(provider)&&!CONTACT.test(provider)&&(found.fa.length||found.cont.length))byProvider[provider]={fundAccountId:found.fa[0]??null,contactId:found.cont[0]??null};}
  return done();
 }
 visit(parsed);return done();
}
/** The TEST bindings for one provider: its own mapping first, otherwise the first fund account for everyone. */
export function uatBeneficiaryFor(map:UatFundAccountMap,providerId:string){
 const own=map.byProvider[providerId],fundAccountId=own?.fundAccountId??map.fundAccounts[0]??null;
 if(!fundAccountId)return null;
 const contactId=own?.contactId??(map.fundAccounts.length===1&&map.contacts.length===1?map.contacts[0]:UAT_SEED_CONTACT_ID);
 return{fundAccountId,contactId};
}

/** Booleans and the human-readable problem list only: never a key, secret, account number or fund account id. */
export function razorpayXTestReadinessSummary(env:Env){
 const readiness=razorpayXSandboxReadiness((env??{}) as Record<string,unknown>);
 return{ready:readiness.ready,problems:readiness.problems,keyIdConfigured:readiness.keyIdConfigured,accountNumberConfigured:readiness.accountNumberConfigured,webhookSecretConfigured:readiness.webhookSecretConfigured,fundAccountMapConfigured:parseUatFundAccountMap(env?.RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX).fundAccounts.length>0,uatSelfHeal:uatPayoutBeneficiaryGate(env)};
}

const tablesReady=new WeakSet<Db>();
async function ensureTables(db:Db){if(tablesReady.has(db))return;await ensureProviderCommissionTables(db);await ensureProviderOnboardingTransactional(db);await ensureVerificationMandateTables(db);tablesReady.add(db);}
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
/** null when the provider already passes the payout beneficiary check, otherwise the check's own reason. */
async function beneficiaryProblem(db:Db,providerId:string,now:number){try{await assertActiveVerifiedPayoutBeneficiary(db,providerId,now);return null;}catch(error){return error instanceof Error?error.message:String(error);}}

/** Every UAT roster id worth looking at when the caller names none: the seeded capacity rows, the runtime defaults, the map's keys. */
async function rosterProviderIds(db:Db,map:UatFundAccountMap,limit:number){
 const ids=new Set<string>([...UAT_DEFAULT_GROOMER_IDS,...Object.keys(map.byProvider)]);
 if(await tableExists(db,"provider_capacity_profiles"))for(const row of (await db.prepare("SELECT id FROM provider_capacity_profiles WHERE id LIKE 'uatcap_%' OR id IN (?,?,?) ORDER BY id LIMIT ?").bind(...UAT_DEFAULT_GROOMER_IDS,Math.max(limit,1)).all<Row>()).results||[])ids.add(text(row.id));
 return[...ids].filter(isUatRosterProviderId).sort().slice(0,limit);
}

type Outcome="created"|"updated"|"kept"|"kept_person"|"existing";
async function healProfile(db:Db,providerId:string,seed:{fundAccountId:string;contactId:string},now:number):Promise<Outcome>{
 const row=await db.prepare("SELECT status,razorpayx_contact_id,razorpayx_fund_account_id,updated_by FROM provider_compensation_profiles WHERE provider_id=?").bind(providerId).first<Row>();
 if(!row){const inserted=await db.prepare("INSERT OR IGNORE INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission',NULL,NULL,?,?,'active',?,?,?,?)").bind(providerId,seed.contactId,seed.fundAccountId,SEED_REASON,UAT_SEED_ACTOR,now,now).run();return changes(inserted)===1?"created":"kept";}
 const provenance=text(row.updated_by),fund=text(row.razorpayx_fund_account_id),contact=text(row.razorpayx_contact_id),person=isPerson(provenance);
 // What is protected is a person's bank details, not their name on the row: Finance approving commercial terms
 // (lib/provider-commission-setup.ts recordProviderEngagement) rewrites updated_by with no contact or fund account at
 // all, and that profile still gets the TEST bindings. updated_by is never rewritten here, so the trail stays theirs.
 if(person&&(fund||contact))return"kept_person";
 // A fund account that already looks real stays, even when it differs from the map; only an empty or malformed one is replaced.
 const nextFund=FUND_ACCOUNT.test(fund)?fund:seed.fundAccountId,nextContact=contact||seed.contactId,nextStatus=person?text(row.status):"active";
 if(nextFund===fund&&nextContact===contact&&nextStatus===text(row.status))return"kept";
 const updated=await db.prepare("UPDATE provider_compensation_profiles SET razorpayx_contact_id=?,razorpayx_fund_account_id=?,status=?,updated_at=? WHERE provider_id=? AND COALESCE(updated_by,'')=?").bind(nextContact,nextFund,nextStatus,now,providerId,provenance).run();
 return changes(updated)===1?"updated":"kept";
}
/** The payout check reads the provider's latest application; a seeded one is added only when there is none at all. */
async function healApplication(db:Db,providerId:string,now:number){
 const latest=await db.prepare("SELECT id FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1").bind(providerId).first<Row>();
 if(latest)return{id:text(latest.id),outcome:"existing" as Outcome};
 const id=`POAPP-UAT-${providerId}`;
 const inserted=await db.prepare("INSERT OR IGNORE INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,policy_ref,quiz_version_ref,verification_status,quiz_status,interview_status,human_decision,contract_type,created_by,created_at,updated_at) VALUES (?,?,?,'IN','KA','BLR',?,'en',?,NULL,NULL,'not_started','not_started','not_started',?,'commission',?,?,?)").bind(id,providerId,UAT_PAYOUT_SEED_VERTICAL,UAT_PAYOUT_SEED_STATUS,JSON.stringify({uatPayoutSeed:true,note:SEED_NOTE}),UAT_PAYOUT_SEED_STATUS,UAT_SEED_ACTOR,now,now).run();
 return{id,outcome:(changes(inserted)===1?"created":"existing") as Outcome};
}
async function healVerification(db:Db,applicationId:string,now:number):Promise<Outcome>{
 const row=await db.prepare("SELECT id,status,expires_at,updated_by FROM provider_verifications WHERE application_id=? AND verification_type='bank_kyc' ORDER BY COALESCE(verified_at,updated_at,created_at) DESC LIMIT 1").bind(applicationId).first<Row>();
 if(!row){const inserted=await db.prepare("INSERT OR IGNORE INTO provider_verifications (id,application_id,category,verification_type,status,automated,provider_ref,detail_json,expires_at,verified_at,updated_by,created_at,updated_at) VALUES (?,?,'','bank_kyc','verified',0,NULL,?,NULL,?,?,?,?)").bind(`PVER-UAT-${applicationId}`,applicationId,JSON.stringify({uatSeed:true,note:SEED_NOTE}),now,UAT_SEED_ACTOR,now,now).run();return changes(inserted)===1?"created":"existing";}
 const expired=row.expires_at!=null&&Number(row.expires_at)<=now;
 if(text(row.status)==="verified"&&!expired)return"existing";
 const provenance=text(row.updated_by);if(isPerson(provenance))return"kept_person";
 const updated=await db.prepare("UPDATE provider_verifications SET status='verified',expires_at=NULL,verified_at=?,detail_json=?,updated_by=?,updated_at=? WHERE id=? AND COALESCE(updated_by,'')=?").bind(now,JSON.stringify({uatSeed:true,note:SEED_NOTE}),UAT_SEED_ACTOR,now,text(row.id),provenance).run();
 return changes(updated)===1?"updated":"kept";
}

export type UatBeneficiaryHeal={enabled:boolean;reason:string|null;providers:string[];healed:string[];unchanged:string[];skipped:Array<{providerId:string;reason:string}>;errors:string[]};
/**
 * Gives each named UAT roster provider (or, when none is named, the seeded roster, a bounded slice at a time) the three
 * records the payout beneficiary check needs, when it does not pass already. Idempotent: a second run finds every
 * provider unchanged and writes nothing. Never throws for one provider's failure; it is named in errors.
 */
export async function ensureUatPayoutBeneficiaries(db:Db,env:Env,input:{providerIds?:string[];now?:number;limit?:number}={}):Promise<UatBeneficiaryHeal>{
 const result:UatBeneficiaryHeal={enabled:false,reason:null,providers:[],healed:[],unchanged:[],skipped:[],errors:[]};
 if(!uatPayoutBeneficiaryGate(env)){result.reason="not_uat_test_runtime";return result;}
 result.enabled=true;
 const now=input.now??Date.now(),limit=Math.max(1,Math.min(100,Number(input.limit||25))),map=parseUatFundAccountMap(env?.RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX);
 const named=[...new Set((input.providerIds||[]).map(text).filter(Boolean))];
 for(const providerId of named)if(!isUatRosterProviderId(providerId))result.skipped.push({providerId,reason:"Not a seeded UAT roster provider; only the UAT roster is ever healed"});
 if(named.length&&!named.some(isUatRosterProviderId)){result.reason="not_uat_roster_providers";return result;}
 await ensureTables(db);
 result.providers=named.length?named.filter(isUatRosterProviderId):await rosterProviderIds(db,map,limit);
 for(const providerId of result.providers){
  try{
   if(!await beneficiaryProblem(db,providerId,now)){result.unchanged.push(providerId);continue;}
   const seed=uatBeneficiaryFor(map,providerId);
   if(!seed){result.skipped.push({providerId,reason:"RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX names no RazorpayX TEST fund account"});continue;}
   const profile=await healProfile(db,providerId,seed,now),application=await healApplication(db,providerId,now),verification=await healVerification(db,application.id,now);
   const problem=await beneficiaryProblem(db,providerId,now);
   if(problem){result.skipped.push({providerId,reason:profile==="kept_person"?`A person saved this provider's bank details, so they were left alone: ${problem}`:problem});continue;}
   if(![profile,application.outcome,verification].some(outcome=>outcome==="created"||outcome==="updated")){result.unchanged.push(providerId);continue;}
   await db.prepare("INSERT INTO provider_onboarding_events (id,application_id,event_type,from_status,to_status,actor_id,detail_json,created_at) VALUES (?,?,'uat_payout_beneficiary_seeded',NULL,'verified',?,?,?)").bind(crypto.randomUUID(),application.id,UAT_SEED_ACTOR,JSON.stringify({providerId,profile,application:application.outcome,verification,fundAccountBound:true,contactBound:true,source:"RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX",environment:"sandbox",liveMoney:false}),now).run();
   result.healed.push(providerId);
  }catch(error){result.errors.push(`${providerId}: ${error instanceof Error?error.message:String(error)}`);}
 }
 return result;
}
