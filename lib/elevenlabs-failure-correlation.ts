import { voiceProviderCorrelation } from "./voice-handset-evidence";

type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const validId = (value: string) => /^[A-Za-z0-9_-]{1,160}$/.test(value);

/** Match a signed failure to persisted acceptance, never a phone, timestamp or latest call. */
export async function resolveElevenLabsFailureCall(db: D1Database, input: {
  conversationId: string; agentId: string; claimedCallId?: string;
}) {
  const conversationId = text(input.conversationId), agentId = text(input.agentId);
  const claimedCallId = text(input.claimedCallId);
  if (!validId(conversationId) || !validId(agentId) || (claimedCallId && !validId(claimedCallId))) {
    throw new Response("Exact ElevenLabs failure identity is required", { status: 409 });
  }
  const result = await db.prepare(
    "SELECT c.id,c.provider_call_id,t.detail_json FROM voice_call_orders c " +
    "JOIN voice_call_state_transitions t ON t.call_id=c.id " +
    "WHERE c.provider='elevenlabs_exotel' AND c.dialed_at IS NOT NULL AND t.to_state='dialing' " +
    "AND CASE WHEN json_valid(t.detail_json) THEN json_extract(t.detail_json,'$.providerCorrelation.conversationId') END=? LIMIT 2"
  ).bind(conversationId).all<Row>();
  if (!Array.isArray(result.results) || result.results.length !== 1) {
    throw new Response("Unique persisted ElevenLabs failure correlation is unavailable", { status: 409 });
  }
  const accepted = result.results[0];
  let detail: Row;
  try { detail = JSON.parse(text(accepted.detail_json)) as Row; }
  catch { throw new Response("Invalid persisted ElevenLabs failure correlation", { status: 409 }); }
  const correlation = voiceProviderCorrelation(detail.providerCorrelation);
  const callId = text(accepted.id);
  const rawCorrelation = detail.providerCorrelation as Row | undefined;
  const providerIdMatches = correlation.carrierCallId
    ? correlation.carrierCallId === text(accepted.provider_call_id)
    : rawCorrelation?.carrierCallId === null && correlation.conversationId === text(accepted.provider_call_id);
  // A signed initiation failure is also conclusive for a uniquely accepted conversation-only receipt.
  // Preserve its missing carrier ID; never substitute a guessed carrier or another call.
  if (!validId(callId) || correlation.conversationId !== conversationId || correlation.agentId !== agentId ||
      !providerIdMatches ||
      (claimedCallId && claimedCallId !== callId)) {
    throw new Response("ElevenLabs failure does not match the accepted call", { status: 409 });
  }
  return callId;
}

/** The same exact persisted acceptance check applies before a successful post-call CRM write. */
export const resolveElevenLabsAcceptedCall = resolveElevenLabsFailureCall;
