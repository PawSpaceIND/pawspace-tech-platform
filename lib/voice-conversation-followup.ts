import { classifyAiIntent, isExplicitCustomerActionConfirmation } from "./ai-conversation-orchestrator";
import { requiresImmediateHumanHandoff } from "./ai-grounded-runtime-provider";
import { detectPromptInjection } from "./ai-evaluation-security";

export type VoiceHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Preserve the current voice conversation's intent only for bounded slot answers/backchannels.
 * Current-turn safety always wins: history cannot override a risky request, prompt injection,
 * human handoff, refund request, or an unrelated utterance.
 */
export function classifyVoiceFollowup(input: string, history: VoiceHistoryMessage[]) {
  const current = classifyAiIntent(input);
  if (
    current.intent !== "unknown" ||
    current.policyRisk ||
    requiresImmediateHumanHandoff(input) ||
    detectPromptInjection(input).blocked
  ) return current;

  const previous = [...history];
  if (previous.at(-1)?.role === "user" && previous.at(-1)?.content === input) previous.pop();
  const lastQuestion = [...previous].reverse().find(message => message.role === "assistant")?.content || "";
  const priorIntent = [...previous]
    .reverse()
    .filter(message => message.role === "user")
    .map(message => classifyAiIntent(message.content))
    .find(intent => intent.intent !== "unknown");

  if (!priorIntent || !["booking_create", "service_info"].includes(priorIntent.intent) || priorIntent.policyRisk) return current;

  const normalized = input.toLowerCase().replace(/[.,!?-]/g, " ").replace(/\s+/g, " ").trim();
  const backchannel = /^(?:(?:hello|hi|okay|ok|sure|thank you|thanks|oh|damn|something|are you there|can you hear me)\s*)+$/.test(normalized);
  const dateAnswer =
    input.length <= 120 &&
    /\b(date|time|when)\b/i.test(lastQuestion) &&
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/i.test(input) &&
    /^(?:i |want |would |like |prefer |for |at |on |please|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|am|pm|a m|p m|[0-9:.,!?\s])+$/i.test(input);
  const confirmation =
    isExplicitCustomerActionConfirmation(input) &&
    !/\b(no|not|never|cancel|stop|wait|hold|don[’']t|without)\b/i.test(lastQuestion) &&
    /\b(confirm|proceed|go ahead|shall i|would you like me to)\b/i.test(lastQuestion) &&
    /\b(book|booking|reserve|slot|checkout)\b/i.test(lastQuestion);
  const addressAnswer =
    input.length <= 240 &&
    /\b(address|pincode|pin code)\b/i.test(lastQuestion) &&
    /\b[1-9][0-9]{5}\b/.test(input);

  if (!backchannel && !dateAnswer && !confirmation && !addressAnswer) return current;
  return {
    ...priorIntent,
    ...(confirmation ? { intent: "booking_create" as const } : {}),
    signals: [...priorIntent.signals, "voice_conversation_followup"],
  };
}
