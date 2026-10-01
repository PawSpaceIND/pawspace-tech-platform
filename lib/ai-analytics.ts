import{ensureD1Once}from"./d1-ensure-once.js";
import{ensureAiConversationOrchestrator}from"./ai-conversation-orchestrator";
import{ensureAiHumanHandoff}from"./ai-human-handoff";
import{ensureAiVoiceUatTables}from"./ai-voice-uat";
import{ensureCommunicationTables}from"./communication-engine";
import{COLLECTED_PAYMENT_STATUSES}from"./collected-funds";

type Row=Record<string,unknown>;
const num=(value:unknown)=>Number(value||0);
const str=(value:unknown)=>String(value??"");

export type AiAnalyticsFilters={from?:number|null;to?:number|null;channel?:"whatsapp"|"chat"|"voice"|null;intent?:string|null};

export async function ensureAiAnalytics(db:D1Database){return ensureD1Once(db,"ai_analytics",async()=>{await ensureCommunicationTables(db);await ensureAiConversationOrchestrator(db);await ensureAiHumanHandoff(db);await ensureAiVoiceUatTables(db);await db.exec("CREATE TABLE IF NOT EXISTS ai_explicit_csat (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,rating INTEGER NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5))");});}

function where(filters:AiAnalyticsFilters){const clauses=["1=1"],values:unknown[]=[];if(filters.from!=null){clauses.push("created_at>=?");values.push(filters.from);}if(filters.to!=null){clauses.push("created_at<=?");values.push(filters.to);}if(filters.channel){clauses.push("channel=?");values.push(filters.channel);}if(filters.intent){clauses.push("intent_code=?");values.push(filters.intent);}return{sql:clauses.join(" AND "),values};}

export type AiBookingOutcomeAccess={allowed:boolean;cityId?:string};
const outcomeCounts=()=>({linkedBookings:null as number|null,bookingsWithCollections:null as number|null,completedBookings:null as number|null,completedWithCollections:null as number|null,collectionsBelowBookingTotal:null as number|null,bookingsWithRefundEvidence:null as number|null,cancelledWithCollections:null as number|null,bookingsWithoutPaymentRecord:null as number|null});
export function unavailableAiBookingOutcomes(reason:"permission_or_scope"|"source_unavailable"){
 return{status:"unavailable" as const,reason,scope:null as string|null,counts:outcomeCounts()};
}

/** Observed current outcomes of distinct bookings linked to the filtered AI-turn cohort.
 * This is neither AI attribution nor a payment-date/revenue report. Read only: missing ledgers
 * refuse the whole outcome block rather than changing an unknown payment into a zero collection.
 */
export async function buildAiBookingOutcomes(db:D1Database,filters:AiAnalyticsFilters,access:AiBookingOutcomeAccess){
 if(!access.allowed)return unavailableAiBookingOutcomes("permission_or_scope");
 const w=where(filters),cityId=access.cityId?.trim().toLowerCase();
 // An explicitly empty organizational scope is never interpreted as company-wide access.
 if(access.cityId!==undefined&&!cityId)return unavailableAiBookingOutcomes("permission_or_scope");
 try{
  const result=await db.prepare(`
   WITH linked AS (
    SELECT DISTINCT booking_id FROM communication_threads
    WHERE booking_id IS NOT NULL AND id IN (SELECT thread_id FROM ai_conversation_turns WHERE ${w.sql})
   ), cohort AS (
    SELECT b.id,b.status,b.total_amount FROM canonical_bookings b JOIN linked l ON l.booking_id=b.id
    ${cityId?"WHERE lower(b.city_id)=?":""}
   ), evidence AS (
    SELECT b.*,p.id payment_id,
     CASE WHEN p.status IN (${COLLECTED_PAYMENT_STATUSES.map(()=>"?").join(",")}) THEN
      CASE WHEN r.payment_id IS NOT NULL THEN MAX(0,ROUND(r.captured_amount-COALESCE((
       SELECT SUM(amount) FROM booking_refund_cases WHERE booking_id=b.id AND purpose='reschedule_difference'
       AND status IN ('requested','approved','processing','processed','completed')),0),2))
       WHEN s.booking_id IS NOT NULL THEN MAX(0,ROUND(s.paid_now_amount+CASE WHEN s.status='paid' THEN s.balance_amount ELSE 0 END,2))
       WHEN t.booking_id IS NOT NULL THEN MAX(0,ROUND(t.booking_fee_amount+CASE WHEN t.status='paid' THEN t.balance_amount ELSE 0 END,2))
       ELSE MAX(0,ROUND(MIN(p.amount_due_now,p.amount),2)) END ELSE 0 END collected,
     CASE WHEN p.status IN ('refunded','partially_refunded') OR COALESCE(r.refunded_amount,0)>0 OR EXISTS(
      SELECT 1 FROM booking_refund_cases f WHERE f.booking_id=b.id AND f.status IN ('processed','completed')
     ) THEN 1 ELSE 0 END refund_evidence
    FROM cohort b LEFT JOIN booking_payments p ON p.booking_id=b.id
    LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id
    LEFT JOIN stay_payment_schedules s ON s.booking_id=b.id
    LEFT JOIN taxi_payment_schedules t ON t.booking_id=b.id
   )
   SELECT COUNT(*) linkedBookings,
    COALESCE(SUM(collected>0),0) bookingsWithCollections,
    COALESCE(SUM(status='completed'),0) completedBookings,
    COALESCE(SUM(status='completed' AND collected>0),0) completedWithCollections,
    COALESCE(SUM(collected>0 AND collected<total_amount),0) collectionsBelowBookingTotal,
    COALESCE(SUM(refund_evidence),0) bookingsWithRefundEvidence,
    COALESCE(SUM(status='cancelled' AND collected>0),0) cancelledWithCollections,
    COALESCE(SUM(payment_id IS NULL),0) bookingsWithoutPaymentRecord
   FROM evidence
  `).bind(...w.values,...(cityId?[cityId]:[]),...COLLECTED_PAYMENT_STATUSES).first<Row>();
  if(!result)throw new Error("Outcome source returned no aggregate");
  const counts=outcomeCounts();
  for(const key of Object.keys(counts) as Array<keyof typeof counts>){
   const value=Number(result[key]);if(result[key]==null||!Number.isSafeInteger(value)||value<0)throw new Error("Invalid outcome aggregate");counts[key]=value;
  }
  return{status:"available" as const,reason:null,scope:cityId??"company",counts};
 }catch{return unavailableAiBookingOutcomes("source_unavailable");}
}

export async function buildAiAnalytics(db:D1Database,filters:AiAnalyticsFilters={}){await ensureAiAnalytics(db);const w=where(filters);
 // One D1 batch replaces nine sequential network round trips; failures stay visible.
 const result=await db.batch([
  db.prepare(`SELECT COUNT(*) total,COUNT(DISTINCT thread_id) threads,SUM(CASE WHEN outcome='handoff' THEN 1 ELSE 0 END) handoffs,COUNT(latency_ms) latency_samples,AVG(latency_ms) avg_latency,SUM(COALESCE(input_tokens,0)) input_tokens,SUM(COALESCE(output_tokens,0)) output_tokens,SUM(COALESCE(cost_minor,0)) cost_minor FROM ai_conversation_turns WHERE ${w.sql}`).bind(...w.values),
  db.prepare(`SELECT channel,COUNT(*) count FROM ai_conversation_turns WHERE ${w.sql} GROUP BY channel ORDER BY count DESC`).bind(...w.values),
  db.prepare(`SELECT intent_code,COUNT(*) count,SUM(CASE WHEN outcome='handoff' THEN 1 ELSE 0 END) handoffs FROM ai_conversation_turns WHERE ${w.sql} GROUP BY intent_code ORDER BY count DESC`).bind(...w.values),
  db.prepare(`SELECT policy_decision,COUNT(*) count FROM ai_conversation_turns WHERE ${w.sql} GROUP BY policy_decision ORDER BY count DESC`).bind(...w.values),
  db.prepare("SELECT reason,COUNT(*) count,AVG(CASE WHEN taken_over_at IS NOT NULL THEN taken_over_at-created_at END) avg_takeover_ms FROM ai_handoffs GROUP BY reason ORDER BY count DESC"),
  db.prepare("SELECT status,outcome,COUNT(*) count,SUM(live_agent_transfer) live_agent_transfers,SUM(reconnect_count) reconnects FROM ai_voice_calls GROUP BY status,outcome ORDER BY count DESC"),
  db.prepare("SELECT event_type,COUNT(*) count FROM communication_message_delivery_events GROUP BY event_type ORDER BY count DESC"),
  db.prepare("SELECT COUNT(*) responses,AVG(rating) average_rating FROM ai_explicit_csat"),
  db.prepare(`SELECT COUNT(*) count FROM communication_threads WHERE booking_id IS NOT NULL AND id IN (SELECT thread_id FROM ai_conversation_turns WHERE ${w.sql})`).bind(...w.values),
 ]);
 const [turnRows,channels,intents,policy,handoffs,voice,delivery,csatRows,linkedRows]=result;
 const turns=turnRows.results[0] as Row|undefined,csat=csatRows.results[0] as Row|undefined,linkedBookings=linkedRows.results[0] as Row|undefined;
 const total=num(turns?.total),handoffCount=num(turns?.handoffs);return{generatedAt:Date.now(),filters,definitions:{scope:"Filters apply to AI turns, performance, policy and booking-linked threads. CSAT, handoff reasons, voice calls and delivery are all-time across all channels, independent of these filters.",volume:"Canonical AI conversation turns only",containment:"AI turns not resulting in governed handoff; not a resolution claim",humanTransfer:"Governed ai_handoffs only",firstResponse:"Not reported until canonical response timing is attributable",resolution:"Not reported until canonical case/thread resolution is attributable",conversion:"Only canonical booking/order linkage may be shown; no causal conversion claim without explicit attribution",csat:"Explicit submitted ratings only; never inferred sentiment",cost:"Provider/model usage fields only when recorded"},volume:{turns:total,threads:num(turns?.threads),byChannel:channels.results.map(r=>({channel:str(r.channel),count:num(r.count)})),byIntent:intents.results.map(r=>({intent:str(r.intent_code),count:num(r.count),handoffs:num(r.handoffs)}))},containment:{handoffTurns:handoffCount,nonHandoffTurns:Math.max(0,total-handoffCount),rate:total?Number(((total-handoffCount)/total).toFixed(4)):null},handoff:{byReason:handoffs.results.map(r=>({reason:str(r.reason),count:num(r.count),avgTakeoverMs:r.avg_takeover_ms==null?null:num(r.avg_takeover_ms)}))},policy:{byDecision:policy.results.map(r=>({decision:str(r.policy_decision),count:num(r.count)}))},performance:{latencySamples:num(turns?.latency_samples),avgLatencyMs:turns?.avg_latency==null?null:num(turns.avg_latency),inputTokens:num(turns?.input_tokens),outputTokens:num(turns?.output_tokens),costMinor:num(turns?.cost_minor)},delivery:{byStatus:delivery.results.map(r=>({status:str(r.event_type),count:num(r.count)}))},voice:{byOutcome:voice.results.map(r=>({status:str(r.status),outcome:str(r.outcome),count:num(r.count),liveAgentTransfers:num(r.live_agent_transfers),reconnects:num(r.reconnects)}))},conversion:{canonicalBookingLinkedThreads:num(linkedBookings?.count),attributedConversionRate:null},csat:{responses:num(csat?.responses),averageRating:csat?.average_rating==null?null:Number(Number(csat.average_rating).toFixed(2)),inferredSentiment:false},firstResponseMs:null,resolutionMs:null,productionReady:false};}
