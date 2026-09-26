/**
 * The single boundary between PawSpace and an external language-model provider.
 * Every external request is privacy-sanitized, governance-checked, budgeted and circuit-broken here.
 */

import { ProviderResponseTooLarge, readBoundedText } from "./provider-response-bounds";
import { sanitizeAiProviderText } from "./ai-provider-safety";
import { completeAiProviderRequest, reserveAiProviderRequest, type AiRuntimeReservation } from "./ai-provider-runtime-control";
import { resolveExplicitAiKillSwitches } from "./ai-runtime-kill-switch";

export type AiProviderRef = "openai" | "anthropic";
export const AI_PROVIDER_REF: AiProviderRef = "anthropic";
export const DEFAULT_AI_MODEL_REF = "gpt-5.6-terra";
export const DEFAULT_VOICE_AI_MODEL_REF = "gpt-5.6-luna";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
export const MAX_AI_RESPONSE_BYTES = 512 * 1024;

export type AiFailureClass =
  | "not_configured"
  | "governance_blocked"
  | "quota_exceeded"
  | "circuit_open"
  | "runtime_control_unavailable"
  | "timeout"
  | "network"
  | "rate_limited"
  | "provider_error"
  | "client_error"
  | "billing_required"
  | "model_unavailable"
  | "oversized_output"
  | "malformed_output"
  | "empty_output";

const RETRYABLE: ReadonlySet<AiFailureClass> = new Set<AiFailureClass>(["timeout", "network", "rate_limited", "provider_error"]);
export const isRetryableAiFailure = (failure: AiFailureClass) => RETRYABLE.has(failure);

const FAILURE_REASON: Record<AiFailureClass, string> = {
  not_configured: "The selected AI provider credential is not configured - no external AI provider is connected and every conversation goes to a human",
  governance_blocked: "External AI is disabled by an active PawSpace AI governance control",
  quota_exceeded: "External AI is temporarily disabled because the configured request, token, or estimated-spend budget has been reached",
  circuit_open: "External AI is temporarily disabled because the provider circuit breaker is open",
  runtime_control_unavailable: "External AI is disabled because its runtime budget control could not be verified",
  timeout: "The AI provider did not respond within the configured deadline",
  network: "The AI provider could not be reached",
  rate_limited: "The AI provider rate-limited this request",
  provider_error: "The AI provider returned a server error",
  client_error: "The AI provider rejected this request",
  billing_required: "The AI provider account needs billing or credit attention",
  model_unavailable: "The configured AI model is unavailable to this provider account",
  oversized_output: "The AI provider response exceeded the size limit and was discarded",
  malformed_output: "The AI provider returned a response this adapter could not parse",
  empty_output: "The AI provider returned no usable text",
};

function reasonFor(failure: AiFailureClass, status?: number): string {
  const base = FAILURE_REASON[failure];
  return Number.isInteger(status) ? `${base} (HTTP ${status})` : base;
}

export type AiDraftFailure = { connected: false; reason: string; failure: AiFailureClass; retryable: boolean; status?: number };
export type AiDraftSuccess = { connected: true; text: string; modelRef: string; providerRef: string; latencyMs: number; stopReason: string | null; usageTokens?: number };
export type AiDraftResult = AiDraftSuccess | AiDraftFailure;

const fail = (failure: AiFailureClass, status?: number): AiDraftFailure => ({
  connected: false,
  reason: reasonFor(failure, status),
  failure,
  retryable: isRetryableAiFailure(failure),
  ...(Number.isInteger(status) ? { status } : {}),
});

async function runtimeEnv(): Promise<Record<string, unknown>> {
  try {
    const { env } = await import("cloudflare:workers");
    return env as unknown as Record<string, unknown>;
  } catch {
    return (globalThis as typeof globalThis & { __PAWSPACE_TEST_ENV__?: Record<string, unknown> }).__PAWSPACE_TEST_ENV__ || {};
  }
}

const str = (env: Record<string, unknown>, key: string) => String(env[key] ?? "").trim();

export function aiProviderRef(env: Record<string, unknown>): AiProviderRef {
  const requested=str(env,"PAWSPACE_AI_PROVIDER").toLowerCase();
  if(requested==="openai")return "openai";
  if(requested==="anthropic")return "anthropic";
  return "anthropic";
}

export function aiProviderCredential(env:Record<string,unknown>,providerRef:AiProviderRef):string{
  return providerRef==="openai"?str(env,"PAWSPACE_OPENAI_API_KEY"):str(env,"PAWSPACE_AI_PROVIDER_API_KEY");
}

export function aiModelRef(env: Record<string, unknown>, channel?: string): { modelRef: string; source: "configured" | "default" } {
  const voiceConfigured = channel === "voice" ? str(env, "PAWSPACE_AI_VOICE_MODEL") : "";
  const configured = voiceConfigured || str(env, "PAWSPACE_AI_PROVIDER_MODEL");
  if (configured) return { modelRef: configured, source: "configured" };
  if (aiProviderRef(env) === "anthropic") return { modelRef: "claude-sonnet-4-6", source: "default" };
  return { modelRef: channel === "voice" ? DEFAULT_VOICE_AI_MODEL_REF : DEFAULT_AI_MODEL_REF, source: "default" };
}

export function aiTimeoutMs(env: Record<string, unknown>): number {
  const raw = Number(str(env, "PAWSPACE_AI_PROVIDER_TIMEOUT_MS"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

export function aiFailureForStatus(status: number): AiFailureClass {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "client_error";
}

export function extractAiText(parsed: unknown): { text: string; stopReason: string | null; usageTokens?: number } | { failure: AiFailureClass } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: "malformed_output" };
  const body = parsed as { content?: unknown; stop_reason?: unknown; type?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (body.type === "error") return { failure: "provider_error" };
  if (!Array.isArray(body.content)) return { failure: "malformed_output" };
  const text = body.content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === "object")
    .filter(block => block.type === "text")
    .map(block => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
  if (!text) return { failure: "empty_output" };
  const inputTokens = Number(body.usage?.input_tokens), outputTokens = Number(body.usage?.output_tokens);
  const usageTokens = Number.isFinite(inputTokens) && inputTokens >= 0 && Number.isFinite(outputTokens) && outputTokens >= 0 ? Math.floor(inputTokens + outputTokens) : undefined;
  return { text, stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null, ...(usageTokens === undefined ? {} : { usageTokens }) };
}



export function extractOpenAiText(parsed: unknown): { text: string; stopReason: string | null; usageTokens?: number } | { failure: AiFailureClass } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: "malformed_output" };
  const body = parsed as { output_text?: unknown; output?: unknown; status?: unknown; error?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown } };
  if (body.error) return { failure: "provider_error" };
  let text = typeof body.output_text === "string" ? body.output_text.trim() : "";
  if (!text && Array.isArray(body.output)) {
    text = body.output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const row = part as { type?: unknown; text?: unknown };
        return row.type === "output_text" && typeof row.text === "string" ? [row.text] : [];
      });
    }).join("\n").trim();
  }
  if (!text) return { failure: "empty_output" };
  const total = Number(body.usage?.total_tokens);
  const input = Number(body.usage?.input_tokens), output = Number(body.usage?.output_tokens);
  const usageTokens = Number.isFinite(total) && total >= 0 ? Math.floor(total) :
    (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? Math.floor(input + output) : undefined);
  return { text, stopReason: typeof body.status === "string" ? body.status : null, ...(usageTokens === undefined ? {} : { usageTokens }) };
}

async function governanceAllowsExternalAi(
  env: Record<string, unknown>,
  input: { channel?: string; intent?: string },
  modelRef: string,
  providerRef: AiProviderRef,
): Promise<boolean> {
  const db = env.DB as D1Database | undefined;
  const production = str(env, "PAWSPACE_DEPLOYMENT_ENV").toLowerCase() === "production";
  if (!db) return !production;
  try {
    const switches = await resolveExplicitAiKillSwitches(db, {
      channel: String(input.channel || "direct"),
      intent: String(input.intent || "direct"),
      provider: providerRef,
      model: modelRef,
    });
    return switches.length === 0;
  } catch {
    // Unit/migration harnesses may not own ai_kill_switches yet. Production never converts an
    // unreadable governance control plane into permission to contact the provider.
    return !production;
  }
}

export async function aiProviderConnection(channel?: string): Promise<{
  configured: boolean;
  connected: boolean;
  verified: false;
  providerRef: string | null;
  modelRef: string | null;
  modelRefSource: "configured" | "default" | null;
  timeoutMs: number;
  reason: string;
}> {
  const env = await runtimeEnv();
  const providerRef = aiProviderRef(env);
  const configured = Boolean(aiProviderCredential(env,providerRef));
  if (!configured) {
    return {
      configured: false, connected: false, verified: false, providerRef: null, modelRef: null, modelRefSource: null,
      timeoutMs: aiTimeoutMs(env), reason: FAILURE_REASON.not_configured,
    };
  }
  const { modelRef, source } = aiModelRef(env,channel);
  return {
    configured: true, connected: true, verified: false, providerRef, modelRef, modelRefSource: source,
    timeoutMs: aiTimeoutMs(env),
    reason: "A provider credential is configured; the model above is what this adapter requests, not a model confirmed to have answered",
  };
}

/**
 * `onDelta` opts one caller into a streamed provider response. Supplying it changes only when text
 * becomes available, never what is generated, governed, reserved or accounted: a live phone caller
 * cannot wait for a complete generation, while chat and WhatsApp are unaffected because they do not
 * pass it. Only the OpenAI provider streams; the Anthropic path ignores it and stays blocking.
 */
export async function requestAiDraft(input: { systemPrompt: string; userPrompt: string; maxTokens?: number; channel?: string; intent?: string; onDelta?: (delta: string) => void; onTiming?: (stage: string) => void }): Promise<AiDraftResult> {
  const env = await runtimeEnv();
  const providerRef = aiProviderRef(env);
  const apiKey = aiProviderCredential(env,providerRef);
  if (!apiKey) return fail("not_configured");
  const { modelRef } = aiModelRef(env, input.channel);
  const mark = (stage: string) => { try { input.onTiming?.(stage); } catch { /* Diagnostics cannot affect provider controls. */ } };
  mark("governanceStarted");
  const governanceAllowed = await governanceAllowsExternalAi(env, input, modelRef, providerRef);
  mark("governanceCompleted");
  if (!governanceAllowed) return fail("governance_blocked");

  const safeSystemPrompt = sanitizeAiProviderText(input.systemPrompt).text;
  const safeUserPrompt = sanitizeAiProviderText(input.userPrompt).text;
  const maxTokens = Math.min(8_000, Math.max(1, Math.floor(Number(input.maxTokens) || 2_000)));
  const db = env.DB as D1Database | undefined;
  if (!db && str(env, "PAWSPACE_DEPLOYMENT_ENV").toLowerCase() === "production") return fail("runtime_control_unavailable");

  let reservation: AiRuntimeReservation = null;
  if (db) {
    mark("reservationStarted");
    const preflight = await reserveAiProviderRequest(db, env, { provider: providerRef, modelRef, channel: input.channel, intent: input.intent, systemPrompt: safeSystemPrompt, userPrompt: safeUserPrompt, maxOutputTokens: maxTokens });
    mark("reservationCompleted");
    if (!preflight.allowed) return fail(preflight.reason);
    reservation = preflight.reservation;
  }

  const finishFailure = async (failure: AiFailureClass, status?: number) => {
    if (db) await completeAiProviderRequest(db, env, { reservation, provider: providerRef, modelRef, failureClass: failure, retryableFailure: isRetryableAiFailure(failure) });
    return fail(failure, status);
  };

  const timeoutMs = aiTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const streaming = Boolean(input.onDelta) && providerRef === "openai";
  try {
    let response: Response;
    try {
      response = providerRef === "openai"
        ? await fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: modelRef, instructions: safeSystemPrompt, input: safeUserPrompt, max_output_tokens: maxTokens, store: false, ...(streaming ? { stream: true } : {}), ...(input.channel === "voice" && modelRef === DEFAULT_VOICE_AI_MODEL_REF ? { reasoning: { effort: "none" } } : {}) }),
          })
        : await fetch(ANTHROPIC_MESSAGES_URL, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
            body: JSON.stringify({ model: modelRef, max_tokens: maxTokens, system: safeSystemPrompt, messages: [{ role: "user", content: safeUserPrompt }] }),
          });
    } catch {
      return await finishFailure(controller.signal.aborted ? "timeout" : "network");
    }

    if (!response.ok) {
      let failure = aiFailureForStatus(response.status);
      // Classify known configuration failures without exposing the provider response or credentials.
      try{
        const body=JSON.parse(await readBoundedText(response,16*1024)) as {error?:{message?:unknown}};
        const message=String(body.error?.message||"");
        if([400,402,403].includes(response.status)&&/credit balance|insufficient (?:credit|fund)|billing|purchase credits/i.test(message))failure="billing_required";
        else if([400,404].includes(response.status)&&/model/i.test(message)&&/not found|does not exist|not available|not have access|deprecated|retired/i.test(message))failure="model_unavailable";
      }catch{/* Status-based classification remains available for malformed or oversized failures. */}
      return await finishFailure(failure, response.status);
    }

    // Time to first byte from the provider. Their marks bracket governance, the reservation and the
    // grounding build; the provider fetch itself was the one unmarked stage, and on a voice turn it
    // is the largest.
    mark("providerHeaders");

    if (streaming) {
      // Same byte ceiling and the same failure classes as the buffered path; the only difference is
      // that each delta is handed to the caller as it lands instead of after the generation ends.
      let streamed = "", pending = "", bytes = 0, stopReason: string | null = null, usageTokens: number | undefined, firstDeltaSeen = false;
      try {
        const decoder = new TextDecoder();
        // An explicit reader rather than for-await: the Workers ReadableStream is not async iterable.
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_AI_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return await finishFailure("oversized_output"); }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          // The last element may be a partial line; keep it for the next chunk.
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;
            let event: { type?: unknown; delta?: unknown; response?: { status?: unknown; usage?: { total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } } };
            try { event = JSON.parse(payload); } catch { continue; }
            if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
              streamed += event.delta;
              // Time to first token: what the caller actually waits through before hearing anything.
              if (!firstDeltaSeen) { firstDeltaSeen = true; mark("providerFirstDelta"); }
              input.onDelta?.(event.delta);
            } else if (event.type === "response.completed" && event.response) {
              if (typeof event.response.status === "string") stopReason = event.response.status;
              const total = Number(event.response.usage?.total_tokens);
              const inTok = Number(event.response.usage?.input_tokens), outTok = Number(event.response.usage?.output_tokens);
              usageTokens = Number.isFinite(total) && total >= 0 ? Math.floor(total)
                : (Number.isFinite(inTok) && inTok >= 0 && Number.isFinite(outTok) && outTok >= 0 ? Math.floor(inTok + outTok) : undefined);
            }
          }
        }
      } catch {
        return await finishFailure(controller.signal.aborted ? "timeout" : "network");
      }
      if (!streamed.trim()) return await finishFailure("empty_output");
      if (db) await completeAiProviderRequest(db, env, { reservation, provider: providerRef, modelRef, actualTokens: usageTokens });
      return {
        connected: true, text: streamed, modelRef, providerRef,
        latencyMs: Date.now() - started, stopReason,
        ...(usageTokens === undefined ? {} : { usageTokens }),
      };
    }

    let raw: string;
    try {
      raw = await readBoundedText(response, MAX_AI_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderResponseTooLarge) return await finishFailure("oversized_output");
      return await finishFailure(controller.signal.aborted ? "timeout" : "network");
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return await finishFailure("malformed_output"); }
    const extracted = providerRef === "openai" ? extractOpenAiText(parsed) : extractAiText(parsed);
    if ("failure" in extracted) return await finishFailure(extracted.failure);

    if (db) await completeAiProviderRequest(db, env, { reservation, provider: providerRef, modelRef, actualTokens: extracted.usageTokens });
    return {
      connected: true,
      text: extracted.text,
      modelRef,
      providerRef,
      latencyMs: Date.now() - started,
      stopReason: extracted.stopReason,
      ...(extracted.usageTokens === undefined ? {} : { usageTokens: extracted.usageTokens }),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyAiProvider(): Promise<{
  verified: boolean;
  providerRef: string | null;
  modelRefRequested: string | null;
  latencyMs: number | null;
  failure: AiFailureClass | null;
  status?: number;
  reason: string;
  checkedAt: number;
}> {
  const checkedAt = Date.now();
  const result = await requestAiDraft({
    systemPrompt: "Reply with the single word OK. No punctuation, no explanation.",
    userPrompt: "readiness probe",
    maxTokens: 8,
    channel: "system",
    intent: "readiness_probe",
  });
  const env = await runtimeEnv();
  const providerRef = aiProviderRef(env);
  const { modelRef } = aiModelRef(env);
  if (!result.connected) {
    return {
      verified: false,
      providerRef: result.failure === "not_configured" ? null : providerRef,
      modelRefRequested: result.failure === "not_configured" ? null : modelRef,
      latencyMs: null, failure: result.failure, ...(result.status === undefined ? {} : { status: result.status }),
      reason: result.reason, checkedAt,
    };
  }
  return {
    verified: true, providerRef: result.providerRef, modelRefRequested: result.modelRef,
    latencyMs: result.latencyMs, failure: null,
    reason: "The AI provider completed a round trip for this probe", checkedAt,
  };
}
