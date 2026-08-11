import { requestAiDraft } from "./ai-provider-adapter";

type QuizQuestion = { questionId: string; prompt: string; competency: string; options: { id: string; label: string }[]; correctAnswerId: string };
export type QuizDraftResult =
  | { connected: true; questions: QuizQuestion[]; modelRef: string; providerRef: string }
  | { connected: false; reason: string };

const SYSTEM_PROMPT = `You write qualification quiz questions for a doorstep pet-care caregiver platform (PawSpace).
Output ONLY valid JSON - an array of exactly 20 objects, no prose, no markdown fences.
Each object: {"questionId": "Q1".."Q20", "prompt": string, "competency": short label like "safety" or "handling", "options": [{"id":"A","label":string},{"id":"B","label":string},{"id":"C","label":string},{"id":"D","label":string}], "correctAnswerId": one of "A"/"B"/"C"/"D"}.
Questions must test real, practical judgement for the given service (safety, hygiene, animal handling, professionalism, escalation) - not trivia. Never write a question implying the caregiver can bypass a real vet, make medical diagnoses, or skip verified safety steps.`;

export async function generateProviderQuizDraft(input: { verticalKey: string; cityCode?: string }): Promise<QuizDraftResult> {
  const result = await requestAiDraft({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Write a 20-question qualification quiz for a "${input.verticalKey}" caregiver applying to work in ${input.cityCode || "Bengaluru"}, India.`,
    maxTokens: 4000,
  });
  if (!result.connected) return { connected: false, reason: result.reason };
  let parsed: unknown;
  try {
    const cleaned = result.text.replace(/^```json\s*|```\s*$/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { connected: false, reason: "AI provider returned output that was not valid JSON - draft was not saved" };
  }
  if (!Array.isArray(parsed) || parsed.length !== 20) {
    return { connected: false, reason: `AI provider returned ${Array.isArray(parsed) ? parsed.length : "non-array"} questions, not exactly 20 - draft was not saved` };
  }
  const questions = parsed as QuizQuestion[];
  for (const q of questions) {
    if (!q.questionId || !q.correctAnswerId || !Array.isArray(q.options) || !q.options.length) {
      return { connected: false, reason: "AI provider returned a malformed question - draft was not saved" };
    }
  }
  return { connected: true, questions, modelRef: result.modelRef, providerRef: result.providerRef };
}
