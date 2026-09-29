type Row = Record<string, unknown>;
export type VoiceProviderCorrelation = { carrierCallId: string | null; conversationId: string | null; agentId: string | null };
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const identifier = (value: unknown) => /^[A-Za-z0-9_-]{1,160}$/.test(text(value)) ? text(value) : null;
const carrierStatuses = new Set(["queued", "initiated", "dialing", "ringing", "in-progress", "in_progress", "completed", "no-answer", "no_answer", "from_leg_unanswered", "to_leg_unanswered", "from_leg_no_dial", "to_leg_no_dial", "failed", "busy", "canceled", "cancelled"]);
const conversationStatuses = new Set(["initiated", "in-progress", "processing", "done", "failed"]);
const safeStatus = (value: unknown, allowed: Set<string>) => allowed.has(text(value).toLowerCase()) ? text(value).toLowerCase() : "unknown";
// Provider numbers may be numeric JSON or a decimal string, never coercible booleans/arrays/objects.
export function positiveTalkSeconds(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}


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
  let correlation = voiceProviderCorrelation(audit.providerCorrelation);
  let correlationSource = "provider_acceptance";
  const carrierBody = row(input.carrier), carrier = row(carrierBody.Call ?? carrierBody.call ?? carrierBody);
  const conversation = row(input.conversation), metadata = row(conversation.metadata), phoneCall = row(metadata.phone_call);
  const status = safeStatus(carrier.Status ?? carrier.status, carrierStatuses);
  const transcript = Array.isArray(conversation.transcript) ? conversation.transcript.map(row) : [];
  const result = (reason: string, passed = false) => ({ passed, reason, correlationSource, carrierStatus: status || null,
    conversationStatus: safeStatus(conversation.status, conversationStatuses), turns: transcript.length, humanQuality: "not_assessed" as const });
  const expectedPhone = canonicalEvidencePhone(input.phone);
  if (!identifier(input.appCallId) || !identifier(input.agentId) || !expectedPhone) return result("invalid_expected_context");
  if (call.callId !== input.appCallId || call.provider !== "elevenlabs_exotel" || call.dialed !== true) return result("app_call_not_verified");
  if (!correlation.carrierCallId && correlation.conversationId && call.providerCallId === correlation.conversationId) {
    try {
      const recovered = partialHandsetCarrier(input);
      if (!recovered) return result("provider_correlation_missing");
      correlation = { ...correlation, carrierCallId: recovered };
      correlationSource = "exact_conversation_metadata";
    } catch { return result("partial_acceptance_identity_mismatch"); }
  }
  if (!correlation.carrierCallId || !correlation.conversationId || correlation.agentId !== input.agentId) return result("provider_correlation_missing");
  const persistedId = correlationSource === "provider_acceptance" ? correlation.carrierCallId : correlation.conversationId;
  if (call.providerCallId !== persistedId || text(carrier.Sid ?? carrier.sid) !== correlation.carrierCallId) return result("carrier_call_identity_mismatch");
  if (canonicalEvidencePhone(carrier.From ?? carrier.from) !== expectedPhone) return result("carrier_recipient_mismatch");
  // Exotel Connect dials From first. This states the carrier outcome, not whether a handset visibly rang.
  if (["no-answer", "no_answer", "from_leg_unanswered"].includes(status)) return result("recipient_leg_not_answered");
  if (["failed", "busy", "canceled", "cancelled", "to_leg_unanswered", "from_leg_no_dial", "to_leg_no_dial"].includes(status)) return result("carrier_not_connected");
  if (status !== "completed") return result("carrier_not_completed");
  const talkSeconds = positiveTalkSeconds(row(carrier.Details ?? carrier.details).ConversationDuration);
  if (talkSeconds === null) return result("carrier_talk_time_not_verified");
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

export const ATTENDED_HANDSET_STATEMENT = 'I answered this exact handset call and heard a complete AI answer to my spoken question.';

/** Participant testimony is a separate evidence class, never fabricated stream counters or recording. */
export function inspectAttendedHandsetEvidence(input: HandsetEvidenceInput, report: unknown, asOf = Date.now()) {
 const automatic = inspectHandsetEvidence(input), r = row(report);
 const call = row(row(input.appAudit).call), metadata = row(row(input.conversation).metadata);
 const output = (reason: string, attendedPassed = false) => ({
  ...automatic, attendedPassed, attendanceReason:reason,
  evidenceClass:attendedPassed ? 'participant_report_with_correlated_provider_metadata' : 'unverified_participant_report',
  recordingChanged:false, audioRecordingInspected:false, answerAccuracy:'not_assessed' as const,
 });
 // All call, recipient, agent, transcript and talk-time checks must succeed first.
 if (!automatic.passed && automatic.reason !== 'two_way_audio_not_verified') return output('technical_prerequisites_not_verified');
 if (call.recordingAllowed !== false) return output('recording_disabled_context_not_verified');
 if (r.schemaVersion !== 1 || r.source !== 'participant_report' || r.appCallId !== input.appCallId ||
     r.statement !== ATTENDED_HANDSET_STATEMENT || r.participant !== 'recipient' ||
     typeof r.recordedBy !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(r.recordedBy)) return output('explicit_exact_call_confirmation_required');
 const start = metadata.start_time_unix_secs, duration = metadata.call_duration_secs, reported = r.reportedAtMs;
 if (typeof start !== 'number' || !Number.isFinite(start) || start <= 0 ||
     typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 ||
     typeof reported !== 'number' || !Number.isSafeInteger(reported) || !Number.isFinite(asOf)) return output('attendance_time_not_verified');
 const endedAt = (start + duration) * 1000;
 if (reported < endedAt || reported > asOf || asOf - reported > 86_400_000 || reported - endedAt > 86_400_000) return output('attendance_outside_call_confirmation_window');
 return output('attended_exchange_confirmed',true);
}

/** Recover only from the exact accepted conversation and its app/agent/recipient bindings.
 * Missing post-processing metadata may be polled; conflicting identity is never retried.
 * This is read-only evidence, not a replacement of the persisted acceptance record.
 */
export function partialHandsetCarrier(input: Pick<HandsetEvidenceInput, 'appCallId'|'agentId'|'phone'|'appAudit'|'conversation'>): string | null {
 const audit=row(input.appAudit),call=row(audit.call),accepted=voiceProviderCorrelation(audit.providerCorrelation);
 const conversation=row(input.conversation),meta=row(conversation.metadata),phoneCall=row(meta.phone_call);
 const vars=row(row(conversation.conversation_initiation_client_data).dynamic_variables);
 if(call.callId!==input.appCallId||call.provider!=='elevenlabs_exotel'||call.dialed!==true||
    row(audit.providerCorrelation).carrierCallId!==null||accepted.carrierCallId||!accepted.conversationId||accepted.agentId!==input.agentId||
    call.providerCallId!==accepted.conversationId)throw Error('Partial acceptance identity mismatch');
 if(conversation.conversation_id!==accepted.conversationId||conversation.agent_id!==input.agentId)
  throw Error('Partial conversation identity mismatch');
 if((vars.pawspace_voice_call_id!=null&&vars.pawspace_voice_call_id!==input.appCallId)||
    (phoneCall.type!=null&&phoneCall.type!=='exotel')||(phoneCall.direction!=null&&phoneCall.direction!=='outbound')||
    (phoneCall.external_number!=null&&canonicalEvidencePhone(phoneCall.external_number)!==canonicalEvidencePhone(input.phone)))
  throw Error('Partial conversation binding mismatch');
 const carrierId=identifier(phoneCall.call_sid);
 if(phoneCall.call_sid!=null&&!carrierId)throw Error('Partial conversation carrier identifier is malformed');
 if(!canonicalEvidencePhone(input.phone)||vars.pawspace_voice_call_id!==input.appCallId||
    phoneCall.type!=='exotel'||phoneCall.direction!=='outbound'||
    canonicalEvidencePhone(phoneCall.external_number)!==canonicalEvidencePhone(input.phone))return null;
 return carrierId;
}
