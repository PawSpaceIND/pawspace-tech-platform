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
