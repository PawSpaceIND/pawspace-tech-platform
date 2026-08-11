/**
 * Shared "call an external AI provider" adapter for provider onboarding assist features
 * (quiz draft generation, interview summary drafting, profile bio drafting).
 *
 * Follows the exact same pattern as every other external integration in this codebase
 * (lib/integration-readiness.ts INT-AI-01: "External provider is not considered connected
 * by default; autonomous governed actions remain prohibited"). This is real, callable code -
 * it will make a genuine API call the moment PAWSPACE_AI_PROVIDER_API_KEY is configured - but
 * fails closed with a clear, honest "not_connected" result until then, exactly like the
 * Razorpay/WhatsApp/Maps adapters do before their sandbox credentials are configured.
 *
 * Governance boundary that must never be removed: every function that calls this adapter
 * produces a DRAFT only. Nothing here is allowed to auto-approve, auto-activate, or auto-decide
 * anything about a real provider application - that authority stays with a human, matching
 * the existing quiz/interview/activation safeguards elsewhere in this cluster.
 */

export type AiDraftResult =
  | { connected: true; text: string; modelRef: string; providerRef: string }
  | { connected: false; reason: string };

async function getApiKey(): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as Record<string, unknown>;
  return String(runtime.PAWSPACE_AI_PROVIDER_API_KEY || "").trim();
}

/**
 * Calls a real AI provider (Anthropic Messages API format) if configured. Returns a clear,
 * honest "not connected" result otherwise - never fabricates AI output locally, and never
 * silently falls back to canned text pretending to be AI-generated.
 */
export async function requestAiDraft(input: { systemPrompt: string; userPrompt: string; maxTokens?: number }): Promise<AiDraftResult> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { connected: false, reason: "PAWSPACE_AI_PROVIDER_API_KEY is not configured - no external AI provider is connected yet" };
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: input.maxTokens ?? 2000,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { connected: false, reason: `AI provider request failed (${response.status}): ${detail.slice(0, 300)}` };
    }
    const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const text = (body.content || []).filter(block => block.type === "text").map(block => block.text || "").join("\n").trim();
    if (!text) return { connected: false, reason: "AI provider returned an empty response" };
    return { connected: true, text, modelRef: "claude-sonnet-4-6", providerRef: "anthropic" };
  } catch (error) {
    return { connected: false, reason: `AI provider request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
