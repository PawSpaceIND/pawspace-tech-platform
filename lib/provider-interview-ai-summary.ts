import { requestAiDraft } from "./ai-provider-adapter";

export type InterviewSummaryDraftResult =
  | { connected: true; summary: string; modelRef: string; providerRef: string }
  | { connected: false; reason: string };

const SYSTEM_PROMPT = `You summarize a doorstep pet-care caregiver's onboarding interview for the human Ops reviewer who will make the actual approve/reject/review decision.
Write a short, neutral summary (120-180 words) covering: overall impression, specific strengths, specific concerns, and any safety or professionalism flags.
Never write a recommendation, a decision, or a score - that stays entirely with the human. Output plain text only, no markdown.`;

export async function generateInterviewSummaryDraft(input: { interviewNotes: string; quizResult?: string; verticalKey?: string }): Promise<InterviewSummaryDraftResult> {
  const result = await requestAiDraft({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Vertical: ${input.verticalKey || "unspecified"}\nQuiz result: ${input.quizResult || "not available"}\n\nOps interviewer's raw notes:\n${input.interviewNotes}`,
    maxTokens: 500,
  });
  if (!result.connected) return { connected: false, reason: result.reason };
  return { connected: true, summary: result.text, modelRef: result.modelRef, providerRef: result.providerRef };
}
