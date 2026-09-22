/**
 * The single boundary between PawSpace and an external language-model provider.
 * Every external request is privacy-sanitized, governance-checked, budgeted and circuit-broken here.
 */

import { ProviderResponseTooLarge, readBoundedText } from "./provider-response-bounds";
import { sanitizeAiProviderText } from "./ai-provider-safety";
import { completeAiProviderRequest, reserveAiProviderRequest, type AiRuntimeReservation } from "./ai-provider-runtime-control";
import { resolveExplicitAiKillSwitches } from "./ai-runtime-kill-switch";

export type AiProviderRef = "openai" | "anthropic";
export const AI_PROVIDER_REF: AiProviderRef = "openai";
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
  not_configured: "PAWSPACE_AI_PROVIDER_API_KEY is not configured - no external AI provider is connected and every conversation goes to a human",
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
  return str(env, "PAWSPACE_AI_PROVIDER").toLowerCase() === "anthropic" ? "anthropic" : "openai";
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

export async function aiProviderConnection(): Promise<{
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
  const configured = Boolean(str(env, "PAWSPACE_AI_PROVIDER_API_KEY"));
  if (!configured) {
    return {
      configured: false, connected: false, verified: false, providerRef: null, modelRef: null, modelRefSource: null,
      timeoutMs: aiTimeoutMs(env), reason: FAILURE_REASON.not_configured,
    };
  }
  const providerRef = aiProviderRef(env);
  const { modelRef, source } = aiModelRef(env);
  return {
    configured: true, connected: true, verified: false, providerRef, modelRef, modelRefSource: source,
    timeoutMs: aiTimeoutMs(env),
    reason: "A provider credential is configured; the model above is what this adapter requests, not a model confirmed to have answered",
  };
}

export async function requestAiDraft(input: { systemPrompt: string; userPrompt: string; maxTokens?: number; channel?: string; intent?: string }): Promise<AiDraftResult> {
  const env = await runtimeEnv();
  const apiKey = str(env, "PAWSPACE_AI_PROVIDER_API_KEY");
  if (!apiKey) return fail("not_configured");

  const providerRef = aiProviderRef(env);
  const { modelRef } = aiModelRef(env, input.channel);
  if (!(await governanceAllowsExternalAi(env, input, modelRef, providerRef))) return fail("governance_blocked");

  const safeSystemPrompt = sanitizeAiProviderText(input.systemPrompt).text;
  const safeUserPrompt = sanitizeAiProviderText(input.userPrompt).text;
  const maxTokens = Math.min(8_000, Math.max(1, Math.floor(Number(input.maxTokens) || 2_000)));
  const db = env.DB as D1Database | undefined;
  if (!db && str(env, "PAWSPACE_DEPLOYMENT_ENV").toLowerCase() === "production") return fail("runtime_control_unavailable");

  let reservation: AiRuntimeReservation = null;
  if (db) {
    const preflight = await reserveAiProviderRequest(db, env, { provider: providerRef, modelRef, channel: input.channel, intent: input.intent, systemPrompt: safeSystemPrompt, userPrompt: safeUserPrompt, maxOutputTokens: maxTokens });
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
  try {
    let response: Response;
    try {
      response = providerRef === "openai"
        ? await fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: modelRef, instructions: safeSystemPrompt, input: safeUserPrompt, max_output_tokens: maxTokens, store: false }),
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
