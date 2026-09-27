import{ensureD1Once}from"./d1-ensure-once.js";
import{ensureAiConversationOrchestrator}from"./ai-conversation-orchestrator";
import{ensureAiHumanHandoff}from"./ai-human-handoff";
import{ensureAiVoiceUatTables}from"./ai-voice-uat";
import{ensureCommunicationTables}from"./communication-engine";

type Row=Record<string,unknown>;
const num=(value:unknown)=>Number(value||0);
const str=(value:unknown)=>String(value??"");

export type AiAnalyticsFilters={from?:number|null;to?:number|null;channel?:"whatsapp"|"chat"|"voice"|null;intent?:string|null};

export async function ensureAiAnalytics(db:D1Database){return ensureD1Once(db,"ai_analytics",async()=>{await ensureCommunicationTables(db);await ensureAiConversationOrchestrator(db);await ensureAiHumanHandoff(db);await ensureAiVoiceUatTables(db);await db.exec("CREATE TABLE IF NOT EXISTS ai_explicit_csat (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,rating INTEGER NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5))");});}

function where(filters:AiAnalyticsFilters){const clauses=["1=1"],values:unknown[]=[];if(filters.from!=null){clauses.push("created_at>=?");values.push(filters.from);}if(filters.to!=null){clauses.push("created_at<=?");values.push(filters.to);}if(filters.channel){clauses.push("channel=?");values.push(filters.channel);}if(filters.intent){clauses.push("intent_code=?");values.push(filters.intent);}return{sql:clauses.join(" AND "),values};}

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
