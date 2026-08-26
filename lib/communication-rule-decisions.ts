/**
 * The nine communication rules, decided. [PTJA-W3-CR]
 *
 * THE APPROVED DECISIONS, in the business's own words:
 *   new-customer welcome         APPROVE               once after verified signup / first valid lead,
 *                                                      kept transactional and service-focused
 *   existing-customer re-engage  APPROVE WITH CONTROLS marketing consent; after 60 days of inactivity;
 *                                                      max once per 30 days; honour opt-out and quiet hours
 *   Training rebooking           APPROVE               at 80% of sessions consumed, or 7 days before
 *                                                      plan validity ends
 *   Boarding rebooking           APPROVE WITH CONTROLS only after a completed stay, marketing consent,
 *                                                      max once per 60 days
 *   Sitting rebooking            APPROVE WITH CONTROLS only after completed service, marketing consent,
 *                                                      max once per 60 days
 *   Dog Walking rebooking        APPROVE               at 80% of walks consumed, or 7 days before expiry
 *   Pet Taxi rebooking           DROP                  event-driven; transactional trip messages only
 *   Fresh Food reordering        APPROVE               from expected consumption/depletion, not a
 *                                                      generic calendar campaign
 *   Relocation rebooking         DROP                  case-based and normally one-time; milestone and
 *                                                      service follow-ups only
 *   Every promotional message must enforce consent, opt-out, frequency limits and deduplication
 *   SERVER-SIDE.
 *
 * WHAT WAS MEASURED BEFORE. lib/lifecycle-reminder-engine.ts already carried all nine as directory rows
 * seeded active:false, configuration_required:1 - the "nine rules awaiting approval" the audit
 * reported. Nobody had decided them. lib/communication-engine.ts enforces marketing consent, opt-out,
 * quiet hours and a GLOBAL weekly marketing cap, but there was no PER-RULE frequency limit, so "max
 * once per 60 days" had nowhere to live. And a DROPPED rule was indistinguishable from an undecided
 * one: both sat inactive, and either could be switched on by anybody with the save route.
 *
 * WHY A DROP IS ENFORCED TWICE. Once on the write path, so the directory cannot be edited to turn it
 * back on, and once at send time, because the directory is data and a row can be changed by other
 * means. A decision should be harder to reverse than a default.
 */
import{ensureLifecycleReminderDefaults}from"./lifecycle-reminder-engine";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const DAY=86_400_000;

export type CommunicationDecision="approve"|"approve_with_controls"|"drop";

export type CommunicationRuleDecision={
  ruleId:string;
  label:string;
  decision:CommunicationDecision;
  /** Does this message need marketing consent, or is it service-focused? */
  requiresMarketingConsent:boolean;
  /** Minimum days between two sends of this rule to one customer. 0 means no interval rule. */
  minIntervalDays:number;
  /** Send at most this many times, ever. null means no lifetime cap. */
  lifetimeCap:number|null;
  /** Days of inactivity required before the rule may fire. 0 means none. */
  requiresInactiveDays:number;
  /** Must a completed service exist first? */
  requiresCompletedService:boolean;
  /** Fire when this fraction of the plan is consumed. null means consumption is not a trigger. */
  consumedFraction:number|null;
  /** Fire this many days before the plan expires. null means expiry is not a trigger. */
  expiryWithinDays:number|null;
  notes:string;
};

export const APPROVED_COMMUNICATION_RULES:CommunicationRuleDecision[]=[
  {ruleId:"rule-new-customer",label:"New-customer welcome",decision:"approve",
   requiresMarketingConsent:false,minIntervalDays:0,lifetimeCap:1,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:null,expiryWithinDays:null,
   notes:"Once after verified signup or first valid lead. Transactional and service-focused, so it does not require marketing consent - but an opt-out still stops it."},
  {ruleId:"rule-existing-customer",label:"Existing-customer re-engagement",decision:"approve_with_controls",
   requiresMarketingConsent:true,minIntervalDays:30,lifetimeCap:null,requiresInactiveDays:60,
   requiresCompletedService:false,consumedFraction:null,expiryWithinDays:null,
   notes:"Marketing consent, 60 days inactive, at most once per 30 days, opt-out and quiet hours honoured."},
  {ruleId:"rule-training-rebook",label:"Training rebooking",decision:"approve",
   requiresMarketingConsent:false,minIntervalDays:0,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:0.8,expiryWithinDays:7,
   notes:"At 80% of sessions consumed, or 7 days before plan validity ends."},
  {ruleId:"rule-boarding-rebook",label:"Boarding rebooking",decision:"approve_with_controls",
   requiresMarketingConsent:true,minIntervalDays:60,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:true,consumedFraction:null,expiryWithinDays:null,
   notes:"Only after a completed stay, with marketing consent, at most once per 60 days."},
  {ruleId:"rule-sitting-rebook",label:"Sitting rebooking",decision:"approve_with_controls",
   requiresMarketingConsent:true,minIntervalDays:60,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:true,consumedFraction:null,expiryWithinDays:null,
   notes:"Only after completed service, with marketing consent, at most once per 60 days."},
  {ruleId:"rule-dog_walking-rebook",label:"Dog Walking rebooking",decision:"approve",
   requiresMarketingConsent:false,minIntervalDays:0,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:0.8,expiryWithinDays:7,
   notes:"At 80% of walks consumed, or 7 days before plan expiry."},
  {ruleId:"rule-pet_taxi-rebook",label:"Pet Taxi rebooking",decision:"drop",
   requiresMarketingConsent:true,minIntervalDays:0,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:null,expiryWithinDays:null,
   notes:"Dropped. Taxi is event-driven; only transactional trip messages are retained."},
  {ruleId:"rule-food-rebook",label:"Fresh Food reordering",decision:"approve",
   requiresMarketingConsent:false,minIntervalDays:0,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:0.8,expiryWithinDays:null,
   notes:"Triggered by expected consumption or depletion, never by a calendar. With no consumption signal it does not fire at all."},
  {ruleId:"rule-relocation-rebook",label:"Relocation rebooking",decision:"drop",
   requiresMarketingConsent:true,minIntervalDays:0,lifetimeCap:null,requiresInactiveDays:0,
   requiresCompletedService:false,consumedFraction:null,expiryWithinDays:null,
   notes:"Dropped. Relocation is case-based and normally one-time; case milestone and service follow-ups are retained."},
];

export function communicationRuleDecision(ruleId:string):CommunicationRuleDecision|null{
  return APPROVED_COMMUNICATION_RULES.find(rule=>rule.ruleId===text(ruleId))??null;
}
export function isDroppedCommunicationRule(ruleId:string){
  return communicationRuleDecision(ruleId)?.decision==="drop";
}

const sendsReady=new WeakSet<Db>();
export async function ensureCommunicationRuleTables(db:Db){
  if(sendsReady.has(db))return;
  await ensureLifecycleReminderDefaults(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS communication_rule_sends (id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,customer_id TEXT NOT NULL,dedupe_key TEXT NOT NULL DEFAULT '',sent_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_rule_dedupe ON communication_rule_sends(rule_id,customer_id,dedupe_key)").run().catch(()=>{});
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_communication_rule_sends ON communication_rule_sends(rule_id,customer_id,sent_at)").run().catch(()=>{});
  sendsReady.add(db);
}

/** Writes the nine decisions into the reminder directory, so nothing is left "awaiting approval". */
export async function applyApprovedCommunicationRules(db:Db,actorId:string){
  await ensureCommunicationRuleTables(db);
  const now=Date.now();
  for(const rule of APPROVED_COMMUNICATION_RULES){
    const active=rule.decision==="drop"?0:1;
    await db.prepare("UPDATE lifecycle_reminder_rules SET active=?,configuration_required=0,notes=?,updated_by=?,updated_at=? WHERE id=?")
      .bind(active,rule.notes,actorId,now,rule.ruleId).run();
    await db.prepare("INSERT INTO lifecycle_reminder_rule_events (id,rule_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(),rule.ruleId,`decision_${rule.decision}`,actorId,JSON.stringify(rule),now).run().catch(()=>{});
  }
  return{applied:APPROVED_COMMUNICATION_RULES.length,
    dropped:APPROVED_COMMUNICATION_RULES.filter(rule=>rule.decision==="drop").map(rule=>rule.ruleId)};
}

export type CommunicationSendContext={
  ruleId:string;customerId:string;
  marketingConsent?:boolean|null;optedOut?:boolean|null;
  lastCompletedServiceAt?:number|null;
  /** How much of the plan or product is used up, 0-1. Null means no signal. */
  fractionConsumed?:number|null;
  daysUntilPlanExpiry?:number|null;
  now?:number;
};

const refuse=(message:string,code:string,extra:Record<string,unknown>={}):never=>{
  throw Response.json({error:message,code,...extra},{status:409});
};

/**
 * May this rule send to this customer right now?
 *
 * Every refusal names itself, because a message that silently does not arrive is indistinguishable
 * from one the platform never tried to send, and the marketing team then reasonably concludes the
 * feature is broken and asks for the controls to be relaxed.
 */
export async function assertCommunicationRuleAllowed(db:Db,input:CommunicationSendContext){
  await ensureCommunicationRuleTables(db);
  const rule=communicationRuleDecision(input.ruleId);
  // A rule nobody decided is not a rule with no restrictions. This is the audit's recurring defect,
  // and in this module it would mean an unreviewed campaign going out under the platform's name.
  if(!rule)refuse(`No approved communication decision exists for ${text(input.ruleId)||"that rule"}`,"communication_rule_undecided");
  if(rule!.decision==="drop")refuse(`${rule!.label} was dropped and does not send`,"communication_rule_dropped");

  const customerId=text(input.customerId);
  if(!customerId)refuse("A customer is required","communication_customer_required");
  const now=input.now??Date.now();

  // An opt-out stops everything, promotional or not. Consent is the narrower question.
  if(input.optedOut===true)refuse("This customer has opted out","communication_opted_out");
  if(rule!.requiresMarketingConsent&&input.marketingConsent!==true)
    refuse(`${rule!.label} is promotional and needs marketing consent`,"communication_marketing_consent_required");

  /*
   * A POSITIVE timestamp, not merely a finite one. Written first as Number.isFinite(Number(value)),
   * which reads as a null check and is not one: Number(null) is 0, and 0 is finite - so "this customer
   * has never completed a service" passed as "they completed one at the epoch". That is this audit's
   * own recurring defect, absence treated as satisfied, and CR-09 caught it.
   */
  const completedAt=Number(input.lastCompletedServiceAt??0);
  if(rule!.requiresCompletedService&&!(Number.isFinite(completedAt)&&completedAt>0))
    refuse(`${rule!.label} only follows a completed service`,"communication_completed_service_required");

  if(rule!.requiresInactiveDays>0){
    const inactiveDays=completedAt>0?(now-completedAt)/DAY:Number.POSITIVE_INFINITY;
    if(inactiveDays<rule!.requiresInactiveDays)
      refuse(`${rule!.label} waits for ${rule!.requiresInactiveDays} days of inactivity`,"communication_customer_still_active",{inactiveDays:Math.floor(inactiveDays)});
  }

  // Consumption / expiry triggers. When a rule declares either, ONE of them must be satisfied - and a
  // rule with no signal at all does not fall back to firing on a date, which is the "generic calendar
  // campaign" the business explicitly ruled out for Fresh Food.
  if(rule!.consumedFraction!==null||rule!.expiryWithinDays!==null){
    const consumed=Number.isFinite(Number(input.fractionConsumed))?Number(input.fractionConsumed):null;
    const expiry=Number.isFinite(Number(input.daysUntilPlanExpiry))?Number(input.daysUntilPlanExpiry):null;
    const consumedHit=rule!.consumedFraction!==null&&consumed!==null&&consumed>=rule!.consumedFraction;
    const expiryHit=rule!.expiryWithinDays!==null&&expiry!==null&&expiry<=rule!.expiryWithinDays;
    if(!consumedHit&&!expiryHit)
      refuse(`${rule!.label} fires on consumption or expiry, not on a date`,"communication_trigger_not_reached",
        {consumedFraction:consumed,daysUntilPlanExpiry:expiry});
  }

  const history=await db.prepare("SELECT COUNT(*) n,MAX(sent_at) last FROM communication_rule_sends WHERE rule_id=? AND customer_id=?")
    .bind(rule!.ruleId,customerId).first<Row>().catch(()=>null);
  const sent=Number(history?.n||0),lastSentAt=Number(history?.last||0);
  if(rule!.lifetimeCap!==null&&sent>=rule!.lifetimeCap)
    refuse(`${rule!.label} sends at most ${rule!.lifetimeCap} time${rule!.lifetimeCap===1?"":"s"}`,"communication_lifetime_cap_reached");
  if(rule!.minIntervalDays>0&&lastSentAt>0&&(now-lastSentAt)/DAY<rule!.minIntervalDays)
    refuse(`${rule!.label} sends at most once every ${rule!.minIntervalDays} days`,"communication_frequency_cap",
      {daysSinceLastSend:Math.floor((now-lastSentAt)/DAY)});

  return{ruleId:rule!.ruleId,decision:rule!.decision,allowed:true as const,sentBefore:sent};
}

/** Records a send. The unique index is what makes a replay a duplicate rather than a second message. */
export async function recordCommunicationRuleSend(db:Db,input:{ruleId:string;customerId:string;dedupeKey?:string;now?:number}){
  await ensureCommunicationRuleTables(db);
  const dedupeKey=text(input.dedupeKey);
  const result=await db.prepare("INSERT OR IGNORE INTO communication_rule_sends (id,rule_id,customer_id,dedupe_key,sent_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(),text(input.ruleId),text(input.customerId),dedupeKey,input.now??Date.now()).run();
  return{ruleId:text(input.ruleId),customerId:text(input.customerId),duplicate:Number(result.meta?.changes||0)===0};
}
