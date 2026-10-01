import type {AuthenticatedActor} from './server-auth';
import {actorCanAccessConversation} from './conversation-access';
import {activeGoalContext} from './goal-context-engine';
import {resolveAiAudienceGate} from './ai-audience-rollout';
import {resolveActiveAiBusinessConfig} from './ai-business-configuration';
import {atlasAiExecutionEnabled} from './atlas-tool-gateway';
import {resolveVerticalRuntime} from './agents/runtime/vertical-runtime';
import {readPersistedGroomingOwnershipLease,persistedOwnershipBatchGuard,
  type PersistedOwnershipLease} from './grooming-persisted-ownership-lease';
import {groomingInstallationPredicate,assertGroomingRevisionInstallation} from './grooming-revision-installation';

type Row=Record<string,unknown>;
type Boundary='generation'|'tool_commit'|'discretionary_send';
type ConfigWindow={id:string;version:number;hash:string;from:number|null;to:number|null};
type Resolved={selectedConfig:{profile:ConfigWindow&{provider:string;model:string};prompt:ConfigWindow}|null;lease:PersistedOwnershipLease; revision:number; databaseIncarnation:string;
 deploymentIncarnation:string; environmentFingerprint:string; goalId:string;
 terms:{offerId:string;quoteJson:string;actionsJson:string;expiresAt:number;confirmed:boolean}|null};
/** Opaque, process-local server capability. It is not a serializable request/body token.
 * A dispatcher must independently resolve authoritative persisted intent context after restart. */
export type GroomingAuthorityHandle=Readonly<{readonly serverOwned:true}>;

export function createGroomingDualModeAuthority(db:D1Database) {
 const issued=new WeakMap<object,{input:{actor:AuthenticatedActor;threadId:string;goalId:string};resolved:Resolved}>();
 async function resolve(input:{actor:AuthenticatedActor;threadId:string;goalId:string},boundary:Boundary):Promise<Resolved> {
  const ai=input.actor.email.endsWith('@system.pawspace');
  if(!input.actor.permissions.includes('*')&&!input.actor.permissions.includes('communications.manage'))
   throw new Response('Conversation authority permission required',{status:403});
  if(ai&&(input.actor.principalType!=='identity_subject'||!input.actor.principalKey.startsWith('service:')))
   throw new Response('Trusted conversation service principal required',{status:403});
  if(!ai&&!await actorCanAccessConversation(db,input.actor,input.threadId))throw new Response('Conversation access denied',{status:403});
  await assertGroomingRevisionInstallation(db);
  const global=await db.prepare('SELECT revision,database_incarnation,(SELECT epoch FROM grooming_revision_installation_epoch WHERE id=1) installation_epoch,(SELECT incarnation FROM grooming_revision_installation_epoch WHERE id=1) installation_incarnation FROM grooming_effective_control_revision WHERE id=1').first<Row>();
  if(!global||!Number.isSafeInteger(Number(global.revision))||Number(global.revision)<1)throw new Response('Control revision unavailable',{status:409});
  const thread=await db.prepare('SELECT customer_id,booking_id,lead_id,(SELECT revision FROM conversation_ownership_revisions WHERE thread_id=communication_threads.id) ownership_revision FROM communication_threads WHERE id=?').bind(input.threadId).first<Row>();
  if(!thread)throw new Response('Conversation not found',{status:404});
  const customerId=String(thread.customer_id);
  if(ai&&thread.lead_id) {
   const leadOwner=await db.prepare("SELECT status,contact_id FROM ai_lead_ownership WHERE lead_id=?").bind(thread.lead_id).first<Row>();
   if(leadOwner&&(leadOwner.status!=="ai_owned"||leadOwner.contact_id!==customerId))throw new Response("Attached lead is owned by employees",{status:409});
  }
  const scope=await db.prepare(`SELECT 1 allowed WHERE
    EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND customer_id=? AND service_code='grooming')
    OR EXISTS(SELECT 1 FROM lead_work_items WHERE id=? AND customer_id=? AND lower(trim(service))='grooming' AND opt_out=0 AND status NOT IN ('closed','merged'))
    OR EXISTS(SELECT 1 FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code='grooming' AND status IN ('pending','executing','completed'))`)
    .bind(thread.booking_id??'',customerId,thread.lead_id??'',customerId,input.threadId,customerId).first();
  if(!scope)throw new Response('Authoritative Grooming scope required',{status:409});
  const lease=await readPersistedGroomingOwnershipLease(db,{threadId:input.threadId,customerId,
    actor:ai?'ai':'employee',employeeEmail:input.actor.email});
  if(lease.ownershipRevision!==Number(thread.ownership_revision)||lease.installationEpoch!==Number(global.installation_epoch)||lease.installationIncarnation!==global.installation_incarnation)throw new Response('Scope changed during authority resolution',{status:409});
  const {env}=await import('cloudflare:workers');const runtime=env as unknown as Row;
  // Hosting must rotate this trusted incarnation on every deployment/config/secret change.
  const deploymentIncarnation=String(runtime.PAWSPACE_DEPLOYMENT_INCARNATION??'').trim();
  if(!deploymentIncarnation)throw new Response('Hosting deployment incarnation required',{status:409});
  const context=await activeGoalContext(db,{goalId:input.goalId});
  if(context.goal.serviceCode!=='grooming')throw new Response('Active Grooming goal required',{status:409});
  const offer=await db.prepare(`SELECT id,quote_json,actions_json,expires_at,status,confirmed_at FROM voice_sales_offers
    WHERE thread_id=? AND customer_id=? AND service_code='grooming' AND status IN ('pending','executing','completed')
    ORDER BY created_at DESC,id DESC LIMIT 1`).bind(input.threadId,customerId).first<Row>();
  const terms=offer?{offerId:String(offer.id),quoteJson:String(offer.quote_json),actionsJson:String(offer.actions_json),
    expiresAt:Number(offer.expires_at),confirmed:offer.confirmed_at!=null&&['executing','completed'].includes(String(offer.status))}:null;
  if(boundary==='tool_commit'&&(!terms||!terms.confirmed||terms.expiresAt<Date.now()))
    throw new Response('Fresh confirmed canonical Grooming terms required',{status:409});
  const routing=await db.prepare(`SELECT mode FROM whatsapp_conversation_routing_modes WHERE thread_id=?`).bind(input.threadId).first<Row>();
  const whatsapp=await db.prepare("SELECT 1 present FROM communication_messages WHERE thread_id=? AND channel='whatsapp' LIMIT 1").bind(input.threadId).first();
  let selectedConfig:Resolved['selectedConfig']=null;
  if(ai||boundary==='generation') {
   const audience=await resolveAiAudienceGate(db,{audience:ai?'customer':'staff'});
   const preliminary=await resolveActiveAiBusinessConfig(db,{channel:whatsapp?'whatsapp':'chat',intent:'booking_create'});
   const selected=preliminary.profile;
   if(!selected?.providerRef||!selected.modelRef)throw new Response('Selected server provider/model required',{status:409});
   const business=await resolveActiveAiBusinessConfig(db,{channel:whatsapp?'whatsapp':'chat',intent:'booking_create',
     provider:selected.providerRef.trim().toLowerCase(),model:selected.modelRef.trim().toLowerCase()});
   if(business.profile?.id!==selected.id||!business.promptPolicy)throw new Response('Selected configuration changed or expired',{status:409});
   const profile=await db.prepare('SELECT id,version,immutable_hash,effective_from,effective_to,provider_ref,model_ref FROM ai_assistant_profile_versions WHERE id=?')
     .bind(selected.id).first<Row>();
   const prompt=await db.prepare('SELECT id,version,immutable_hash,effective_from,effective_to FROM ai_prompt_policy_versions WHERE id=?')
     .bind(business.promptPolicy.id).first<Row>();
   const window=(row:Row|null):ConfigWindow=>{if(!row)throw new Response('Selected configuration unavailable',{status:409});
     const from=row.effective_from==null?null:Number(row.effective_from),to=row.effective_to==null?null:Number(row.effective_to);
     if((from!==null&&(!Number.isFinite(from)||from>Date.now()))||(to!==null&&(!Number.isFinite(to)||to<Date.now())))
       throw new Response('Selected configuration window expired',{status:409});
     return {id:String(row.id),version:Number(row.version),hash:String(row.immutable_hash),from,to};};
   if(profile?.provider_ref!==selected.providerRef||profile?.model_ref!==selected.modelRef)
     throw new Response('Selected provider/model changed',{status:409});
   selectedConfig={profile:{...window(profile),provider:selected.providerRef,model:selected.modelRef},prompt:window(prompt)};
   const executiveEnabled=await atlasAiExecutionEnabled(db,runtime);
   const vertical=resolveVerticalRuntime({PAWSPACE_AI_EXECUTIVE_ACTIVE:executiveEnabled,AI_ATLAS_ACTIVE:runtime.AI_ATLAS_ACTIVE,
     AI_SALES_ACTIVE:runtime.AI_SALES_ACTIVE,AI_EXTERNAL_COMMUNICATION_ACTIVE:runtime.AI_EXTERNAL_COMMUNICATION_ACTIVE},'sales',context.goal.autonomyMode);
   if(!audience.allowed||!business.enabled||business.configurationRequired||vertical.mode==='disabled'||
      (ai&&whatsapp&&routing?.mode!=='ai_assistant')||
      (ai&&boundary!=='generation'&&(context.goal.autonomyMode!=='execute_within_envelope'||vertical.mode!=='execute_within_envelope')))
     throw new Response('Existing effective AI controls require employee continuation',{status:409});
  }
  const environmentFingerprint=JSON.stringify([deploymentIncarnation,runtime.PAWSPACE_DEPLOYMENT_ENV,
    runtime.PAWSPACE_AI_EXECUTIVE_ACTIVE,runtime.AI_ATLAS_ACTIVE,runtime.AI_SALES_ACTIVE,runtime.AI_EXTERNAL_COMMUNICATION_ACTIVE]);
  // Readers may initialize existing runtime schemas; capture revision AGAIN and reject intervening writes.
  const latest=await db.prepare('SELECT revision,database_incarnation,(SELECT epoch FROM grooming_revision_installation_epoch WHERE id=1) installation_epoch,(SELECT incarnation FROM grooming_revision_installation_epoch WHERE id=1) installation_incarnation FROM grooming_effective_control_revision WHERE id=1').first<Row>();
  if(latest?.revision!==global.revision||latest?.database_incarnation!==global.database_incarnation||
     latest?.installation_epoch!==global.installation_epoch||latest?.installation_incarnation!==global.installation_incarnation)
    throw new Response('Controls changed during authority resolution',{status:409});
  return {selectedConfig,lease,revision:Number(global.revision),databaseIncarnation:String(global.database_incarnation),
    deploymentIncarnation,environmentFingerprint,goalId:input.goalId,terms};
 }
 function get(handle:GroomingAuthorityHandle) {
  const value=issued.get(handle);if(!value)throw new Response('Server-issued authority required',{status:403});return value;
 }
 async function refreshCheck(handle:GroomingAuthorityHandle,boundary:Boundary) {
  const value=get(handle),current=await resolve(value.input,boundary);
  if(JSON.stringify(current)!==JSON.stringify(value.resolved))throw new Response('Stale effective authority; refresh',{status:409});
  return current;
 }
 return {
  async issue(input:{actor:AuthenticatedActor;threadId:string;goalId:string},boundary:Boundary) {
   const trustedInput={...input,actor:{...input.actor,permissions:[...input.actor.permissions]}};
   const resolved=await resolve(trustedInput,boundary),handle=Object.freeze({serverOwned:true as const});
   issued.set(handle,{input:trustedInput,resolved});return handle;
  },
  async generate<T>(handle:GroomingAuthorityHandle,provider:{provider:string;modelRef:string|null;
    status:'connected'|'not_connected'|'degraded';run:()=>Promise<T>}) {
   const current=await refreshCheck(handle,'generation'),selected=current.selectedConfig?.profile;
   if(!selected||provider.status!=='connected'||provider.provider!==selected.provider||provider.modelRef!==selected.model)
     throw new Response('Actual provider/model does not match selected server configuration',{status:409});
   const result=await provider.run();await refreshCheck(handle,'generation');return result;
  },
  /** Caller passes existing canonical statements AFTER existing role/consent/finance validation.
   * No async handler invocation is hidden here; fencing and writes share the SAME D1 batch.
   * Hosted incarnation changes cannot share a D1 transaction: hosting must drain old deployments. */
  async commitCanonicalBatch(handle:GroomingAuthorityHandle,boundary:Exclude<Boundary,'generation'>,statements:D1PreparedStatement[]) {
   const current=await refreshCheck(handle,boundary);
   const controls=db.prepare(`SELECT CASE WHEN (${groomingInstallationPredicate}) AND
     EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1 AND revision=? AND database_incarnation=?)
     THEN 1 ELSE abs(-9223372036854775808) END`).bind(current.revision,current.databaseIncarnation);
   const goal=db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM gce_goals WHERE id=? AND status='active'
     AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND service_code='grooming'
     AND starts_at<=CAST(strftime('%s','now') AS INTEGER)*1000
     AND (ends_at IS NULL OR ends_at>(CAST(strftime('%s','now') AS INTEGER)+1)*1000))
     THEN 1 ELSE abs(-9223372036854775808) END`).bind(current.goalId);
   const config=current.selectedConfig;
   const selectedConfiguration=config?[
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ai_assistant_profile_versions WHERE id=? AND version=?
      AND immutable_hash=? AND provider_ref=? AND model_ref=? AND status='active'
      AND effective_from IS ? AND effective_to IS ?
      AND (effective_from IS NULL OR effective_from<=CAST(strftime('%s','now') AS INTEGER)*1000)
      AND (effective_to IS NULL OR effective_to>=(CAST(strftime('%s','now') AS INTEGER)+1)*1000))
      THEN 1 ELSE abs(-9223372036854775808) END`).bind(config.profile.id,config.profile.version,config.profile.hash,
        config.profile.provider,config.profile.model,config.profile.from,config.profile.to),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ai_prompt_policy_versions WHERE id=? AND version=?
      AND immutable_hash=? AND status='active' AND effective_from IS ? AND effective_to IS ?
      AND (effective_from IS NULL OR effective_from<=CAST(strftime('%s','now') AS INTEGER)*1000)
      AND (effective_to IS NULL OR effective_to>=(CAST(strftime('%s','now') AS INTEGER)+1)*1000))
      THEN 1 ELSE abs(-9223372036854775808) END`).bind(config.prompt.id,config.prompt.version,config.prompt.hash,config.prompt.from,config.prompt.to)
   ]:[];
   const terms=boundary==='tool_commit' ?[db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM voice_sales_offers
     WHERE id=? AND thread_id=? AND customer_id=? AND service_code='grooming' AND quote_json=? AND actions_json=?
     AND confirmed_at IS NOT NULL AND status IN ('executing','completed')
     AND expires_at>=(CAST(strftime('%s','now') AS INTEGER)+1)*1000)
     THEN 1 ELSE abs(-9223372036854775808) END`).bind(current.terms!.offerId,current.lease.threadId,
       current.lease.customerId,current.terms!.quoteJson,current.terms!.actionsJson)]:[];
   try {return await db.batch([persistedOwnershipBatchGuard(db,current.lease),controls,goal,...selectedConfiguration,...terms,...statements]);}
   catch(error) {if(/integer overflow/i.test(error instanceof Error?error.message:String(error)))
     throw new Response('Effective authority changed before canonical commit',{status:409});throw error;}
  }
 };
}
