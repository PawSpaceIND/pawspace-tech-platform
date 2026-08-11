import { requestAiDraft } from "./ai-provider-adapter";

export type ProfileBioDraftResult =
  | { connected: true; bio: string; modelRef: string; providerRef: string }
  | { connected: false; reason: string };

const SYSTEM_PROMPT = `You draft a short, warm public bio (60-90 words) for a doorstep pet-care caregiver's profile on PawSpace.
Write in first person, friendly and genuine, no clichés like "passionate about animals" repeated verbatim, no fabricated specific claims (years of experience, certifications, numbers) unless they were actually given to you.
This is a DRAFT the caregiver will read and edit themselves before it's ever shown to a customer - write something they'd plausibly want to personalize, not a finished ad. Output plain text only.`;

export async function generateProviderProfileBioDraft(input: { verticalKey: string; cityCode?: string; displayName?: string; businessName?: string }): Promise<ProfileBioDraftResult> {
  const result = await requestAiDraft({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Service: ${input.verticalKey}\nCity: ${input.cityCode || "Bengaluru"}\nName: ${input.displayName || "the caregiver"}${input.businessName ? `\nBusiness name: ${input.businessName}` : ""}`,
    maxTokens: 300,
  });
  if (!result.connected) return { connected: false, reason: result.reason };
  return { connected: true, bio: result.text, modelRef: result.modelRef, providerRef: result.providerRef };
}
