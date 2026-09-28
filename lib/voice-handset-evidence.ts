type Row = Record<string, unknown>;
export type VoiceProviderCorrelation = { carrierCallId: string | null; conversationId: string | null; agentId: string | null };
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const identifier = (value: unknown) => /^[A-Za-z0-9_-]{1,160}$/.test(text(value)) ? text(value) : null;

// Evidence matching is deliberately India-mobile-only. It never authorizes or formats a dial.
// Equivalent local forms are tested against the actual application canonicalizer.
function canonicalEvidencePhone(value: unknown): string | null {
  const raw = text(value).replace(/[\s()\-.]/g, "");
  if (/^\+91[6-9]\d{9}$/.test(raw)) return raw;
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  if (/^0[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(1)}`;
  return /^[6-9]\d{9}$/.test(raw) ? `+91${raw}` : null;
}

/** Curated identifiers only. No provider response, credential, transcript, or phone is persisted here. */
export function voiceProviderCorrelation(value: unknown): VoiceProviderCorrelation {
  const data = row(value);
  return { carrierCallId: identifier(data.carrierCallId), conversationId: identifier(data.conversationId), agentId: identifier(data.agentId) };
}

/** Legacy records are explicitly uncorrelated; never guess from the newest conversation or a timestamp. */
export function correlationFromVoiceTransitions(transitions: unknown): VoiceProviderCorrelation | null {
  if (!Array.isArray(transitions)) return null;
  const accepted = transitions.filter(value => row(value).to_state === "dialing");
  if (accepted.length !== 1) return null;
  try {
    const detail = row(JSON.parse(text(row(accepted[0]).detail_json)));
    if (!detail.providerCorrelation) return null;
    return voiceProviderCorrelation(detail.providerCorrelation);
  } catch { return null; }
}

export type HandsetEvidenceInput = {
  appCallId: string; agentId: string; phone: string;
  appAudit: unknown; carrier: unknown; conversation: unknown; liveAudioEvidence?: unknown;
};
/** Pure evaluation of an exact call. This function cannot dial, change consent, or repair records. */
export function inspectHandsetEvidence(input: HandsetEvidenceInput) {
  const audit = row(input.appAudit), call = row(audit.call);
  const correlation = voiceProviderCorrelation(audit.providerCorrelation);
  const carrierBody = row(input.carrier), carrier = row(carrierBody.Call ?? carrierBody.call ?? carrierBody);
  const conversation = row(input.conversation), metadata = row(conversation.metadata), phoneCall = row(metadata.phone_call);
  const status = text(carrier.Status ?? carrier.status).toLowerCase();
  const transcript = Array.isArray(conversation.transcript) ? conversation.transcript.map(row) : [];
  const result = (reason: string, passed = false) => ({ passed, reason, carrierStatus: status || null,
    conversationStatus: text(conversation.status) || null, turns: transcript.length, humanQuality: "not_assessed" as const });
  const expectedPhone = canonicalEvidencePhone(input.phone);
  if (!identifier(input.appCallId) || !identifier(input.agentId) || !expectedPhone) return result("invalid_expected_context");
  if (call.callId !== input.appCallId || call.provider !== "elevenlabs_exotel" || call.dialed !== true) return result("app_call_not_verified");
  if (!correlation.carrierCallId || !correlation.conversationId || correlation.agentId !== input.agentId) return result("provider_correlation_missing");
  if (call.providerCallId !== correlation.carrierCallId || text(carrier.Sid ?? carrier.sid) !== correlation.carrierCallId) return result("carrier_call_identity_mismatch");
  if (canonicalEvidencePhone(carrier.From ?? carrier.from) !== expectedPhone) return result("carrier_recipient_mismatch");
  // Exotel Connect dials From first. This states the carrier outcome, not whether a handset visibly rang.
  if (["no-answer", "no_answer", "from_leg_unanswered"].includes(status)) return result("recipient_leg_not_answered");
  if (["failed", "busy", "canceled", "cancelled", "to_leg_unanswered", "from_leg_no_dial", "to_leg_no_dial"].includes(status)) return result("carrier_not_connected");
  if (status !== "completed") return result("carrier_not_completed");
  const talkSeconds = Number(row(carrier.Details ?? carrier.details).ConversationDuration);
  if (!Number.isFinite(talkSeconds) || talkSeconds <= 0) return result("carrier_talk_time_not_verified");
  if (conversation.conversation_id !== correlation.conversationId || conversation.agent_id !== input.agentId) return result("conversation_identity_mismatch");
  if (phoneCall.type !== "exotel" || phoneCall.direction !== "outbound" || phoneCall.call_sid !== correlation.carrierCallId) return result("conversation_carrier_link_missing");
  if (canonicalEvidencePhone(phoneCall.external_number) !== expectedPhone) return result("conversation_recipient_mismatch");
  if (conversation.status !== "done") return result("conversation_not_completed");
  if (metadata.text_only === true) return result("text_session_is_not_a_handset_call");
  const userIndex = transcript.findIndex(turn => turn.role === "user" && text(turn.message));
  const reply = userIndex < 0 ? undefined : transcript.slice(userIndex + 1).find(turn => turn.role === "agent" && text(turn.message));
  if (!reply || reply.interrupted === true) return result("complete_reply_not_verified");
  if (/^(?:(?:one moment|just a moment|please wait|let me check|I'm checking the details)[.! …]*)$/i.test(text(reply.message))) return result("substantive_reply_not_verified");
  const live = row(input.liveAudioEvidence);
  const streamVerified = live.conversationId === correlation.conversationId && live.inputMode === "audio" &&
    [live.inputBytes, live.outputBytes, live.nonSilentBytes].every(value => typeof value === "number" && Number.isFinite(value) && value > 0) && live.playbackComplete === true;
  const storedAudio = conversation.has_user_audio === true && conversation.has_response_audio === true;
  if (!storedAudio && !streamVerified) return result("two_way_audio_not_verified");
  return result("correlated_conversation_exchange_verified", true);
}

export function assertHandsetEvidence(input: HandsetEvidenceInput) {
  const evidence = inspectHandsetEvidence(input);
  if (!evidence.passed) throw new Error(`Handset conversation not verified: ${evidence.reason}`);
  return evidence;
}
