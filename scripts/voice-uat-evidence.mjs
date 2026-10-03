// Provider acceptance and greeting audio alone do not prove a working conversation.
export function conversationEvidence(detail, carrier, expectedAgentId) {
  const transcript = Array.isArray(detail?.transcript) ? detail.transcript : [];
  const userIndex = transcript.findIndex(turn => turn?.role === 'user' && String(turn.message || '').trim());
  const replied = userIndex >= 0 && transcript.slice(userIndex + 1).some(turn => turn?.role === 'agent' && String(turn.message || '').trim());
  const carrierFailed = ['no-answer', 'busy', 'failed', 'canceled', 'cancelled'].includes(String(carrier?.status || '').toLowerCase());
  const terminal = carrierFailed || ['done', 'failed'].includes(detail?.status);
  const reason = detail?.agent_id !== expectedAgentId ? 'wrong_or_missing_agent'
    : carrierFailed ? 'carrier_did_not_connect'
    : detail?.status === 'failed' ? 'conversation_failed'
    : !replied ? 'no_agent_reply_after_user_turn'
    : !detail?.has_user_audio || !detail?.has_response_audio ? 'conversation_audio_not_verified'
    : detail?.status !== 'done' ? 'conversation_not_finished'
    : 'conversation_verified';
  return {passed: reason === 'conversation_verified', terminal, reason, turns: transcript.length, userTurn: userIndex >= 0, agentReplyAfterUser: replied};
}

// This predicate measures substantive task-answer evidence, not whether audio existed or a safe
// escalation succeeded. Emergency guidance is a valid safety outcome, not a completed grooming sale.
const withoutProgress=reply=>String(reply||'').replace(/^(?:(?:I'm checking the details|One moment while I check that for you|Sure, give me a second|Give me a second|Just a moment|Please wait)[. …,!]*\s*)+/i,'').trim();
// Match a controlled whole-turn opening, not incidental support advice after a useful answer.
export const isControlledVoiceReply=reply=>/^(?:Your request is queued for a PawSpace teammate|A PawSpace teammate owns this conversation|PawSpace['’]s team needs to help with this request|Please have your booking reference or requested service details and a short description of the issue ready|This conversation is waiting for a PawSpace team member|(?:I[’']m )?routing this (?:(?:conversation|call) )?to a PawSpace team member|(?:I |We )?cannot continue the booking|AI voice cannot continue this conversation|Customer AI voice is unavailable|AI replies are paused while the conversation is owned by staff|PawSpace custom LLM failed safely|(?:Please )?contact your nearest emergency vet immediately|Please don[’']t wait for a response here)/i.test(withoutProgress(reply));

// Progress keeps the stream active but cannot prove that the agent answered the caller.
export function isSubstantiveVoiceReply(reply){
 const text=withoutProgress(reply);
 return Boolean(text)&&!isControlledVoiceReply(text)&&!/^(?:sure[, ]*)?(?:one moment|just a moment|give me a second|let me check|please wait)/i.test(text);
}

// A finished model session cannot stand in for a carrier-confirmed connected call.
export function assertCompletedCarrier(carrier){
 const duration=Number(carrier?.duration);
 if(String(carrier?.status||'').toLowerCase()!=='completed'||!Number.isFinite(duration)||duration<=0)throw Error('Carrier has not confirmed a completed connected call');
 return true;
}
