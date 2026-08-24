/**
 * The single boundary between PawSpace and an external language-model provider.
 *
 * Everything here exists because the previous version of this file was three lines of `fetch` with
 * no deadline, no size bound, no output validation and a `reason` string built by pasting the
 * provider's own response body into it. Each of those is the same defect class the telephony adapter
 * was hardened against, and each has a concrete failure:
 *
 *   No deadline          a provider that accepts the connection and then stalls holds a Worker
 *                        request open until the platform kills it. The caller sees a generic 500,
 *                        not "the provider timed out", so nothing retries and nothing escalates.
 *   Headers-only timeout an AbortController released after `await fetch` bounds the handshake and
 *                        not the body. A provider that sends headers and then trickles bytes is
 *                        unbounded again, which is why the signal here is held until the body is read.
 *   No size bound        `await response.text()` on an untrusted origin buffers whatever arrives.
 *   No output validation `(body.content || [])` throws on a null body, so a provider answering
 *                        `null` with HTTP 200 crashed the caller instead of degrading to a handoff.
 *   Provider body echoed `detail.slice(0, 300)` put arbitrary provider output into a `reason` that
 *                        is rendered on staff screens and written to audit rows. A provider error
 *                        body can quote the request that caused it - which is our prompt, and in the
 *                        worst case the header block around it. Audit evidence must be safe to keep
 *                        forever, so failures are described from a fixed vocabulary of our own and
 *                        the numeric status, never from provider text.
 *   Unverified modelRef  `aiProviderConnection()` returned `modelRef: "claude-sonnet-4-6"` whenever
 *                        a key existed. A key is configuration; it proves nothing about which model
 *                        answers or whether anything answers at all. The model this adapter would
 *                        REQUEST is reported as exactly that, and `verified` stays false until
 *                        `verifyAiProvider` actually completes a round trip.
 *
 * Nothing in this file logs, returns or persists the prompt. The failure vocabulary below is the
 * complete set of strings that can reach a caller, so a leak has to be introduced deliberately.
 */

import { ProviderResponseTooLarge, readBoundedText } from "./provider-response-bounds";

/** The model this adapter requests when the environment does not name one. */
export const DEFAULT_AI_MODEL_REF = "claude-sonnet-4-6";
export const AI_PROVIDER_REF = "anthropic";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
/** A drafting response is a few KB. 512 KB is generous headroom and still a hard ceiling. */
export const MAX_AI_RESPONSE_BYTES = 512 * 1024;

/**
 * Why a request did not produce usable text. `retryable` is the only thing a caller needs to decide
 * whether to try again: a 400 will fail identically forever, a 429 or a timeout will not.
 */
export type AiFailureClass =
  | "not_configured"
  | "timeout"
  | "network"
  | "rate_limited"
  | "provider_error"
  | "client_error"
  | "oversized_output"
  | "malformed_output"
  | "empty_output";

const RETRYABLE: ReadonlySet<AiFailureClass> = new Set<AiFailureClass>(["timeout", "network", "rate_limited", "provider_error"]);
export const isRetryableAiFailure = (failure: AiFailureClass) => RETRYABLE.has(failure);

/**
 * The complete set of caller-visible failure text. Nothing here interpolates provider output, prompt
 * text, a credential or a URL; the only variable admitted is a numeric HTTP status.
 */
const FAILURE_REASON: Record<AiFailureClass, string> = {
  not_configured: "PAWSPACE_AI_PROVIDER_API_KEY is not configured - no external AI provider is connected and every conversation goes to a human",
  timeout: "The AI provider did not respond within the configured deadline",
  network: "The AI provider could not be reached",
  rate_limited: "The AI provider rate-limited this request",
  provider_error: "The AI provider returned a server error",
  client_error: "The AI provider rejected this request",
  oversized_output: "The AI provider response exceeded the size limit and was discarded",
  malformed_output: "The AI provider returned a response this adapter could not parse",
  empty_output: "The AI provider returned no usable text",
};

function reasonFor(failure: AiFailureClass, status?: number): string {
  const base = FAILURE_REASON[failure];
  return Number.isInteger(status) ? `${base} (HTTP ${status})` : base;
}

export type AiDraftFailure = { connected: false; reason: string; failure: AiFailureClass; retryable: boolean; status?: number };
export type AiDraftSuccess = { connected: true; text: string; modelRef: string; providerRef: string; latencyMs: number; stopReason: string | null };
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
    return {};
  }
}

const str = (env: Record<string, unknown>, key: string) => String(env[key] ?? "").trim();

/** The model this adapter will ask for. Reporting it is not a claim that it answered. */
export function aiModelRef(env: Record<string, unknown>): { modelRef: string; source: "configured" | "default" } {
  const configured = str(env, "PAWSPACE_AI_PROVIDER_MODEL");
  return configured ? { modelRef: configured, source: "configured" } : { modelRef: DEFAULT_AI_MODEL_REF, source: "default" };
}

export function aiTimeoutMs(env: Record<string, unknown>): number {
  const raw = Number(str(env, "PAWSPACE_AI_PROVIDER_TIMEOUT_MS"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

/** Maps a provider HTTP status onto the failure vocabulary. */
export function aiFailureForStatus(status: number): AiFailureClass {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "client_error";
}

/**
 * Turns whatever a 200 response actually contained into text, or names why it could not. Every branch
 * here is a shape a real provider can return: a null body, a body whose `content` is absent or not an
 * array, blocks with no `text`, or text that is only whitespace.
 */
export function extractAiText(parsed: unknown): { text: string; stopReason: string | null } | { failure: AiFailureClass } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: "malformed_output" };
  const body = parsed as { content?: unknown; stop_reason?: unknown; type?: unknown };
  if (body.type === "error") return { failure: "provider_error" };
  if (!Array.isArray(body.content)) return { failure: "malformed_output" };
  const text = body.content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === "object")
    .filter(block => block.type === "text")
    .map(block => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
  if (!text) return { failure: "empty_output" };
  return { text, stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null };
}

/**
 * Configuration status. `connected` here means "a credential is present, so this adapter will attempt
 * provider calls" - it is deliberately NOT a reachability claim, and `verified` says so out loud.
 * Only `verifyAiProvider` can produce evidence that the provider answered.
 */
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
  const { modelRef, source } = aiModelRef(env);
  return {
    configured: true, connected: true, verified: false, providerRef: AI_PROVIDER_REF, modelRef, modelRefSource: source,
    timeoutMs: aiTimeoutMs(env),
    reason: "A provider credential is configured; the model above is what this adapter requests, not a model confirmed to have answered",
  };
}

export async function requestAiDraft(input: { systemPrompt: string; userPrompt: string; maxTokens?: number }): Promise<AiDraftResult> {
  const env = await runtimeEnv();
  const apiKey = str(env, "PAWSPACE_AI_PROVIDER_API_KEY");
  if (!apiKey) return fail("not_configured");

  const { modelRef } = aiModelRef(env);
  const timeoutMs = aiTimeoutMs(env);
  const controller = new AbortController();
  // Released in `finally`, not after `await fetch`: a provider that answers with headers and then
  // trickles the body must hit the same deadline as one that never answers at all.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    let response: Response;
    try {
      response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: modelRef,
          max_tokens: Math.min(8_000, Math.max(1, Math.floor(Number(input.maxTokens) || 2_000))),
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }],
        }),
      });
    } catch {
      return fail(controller.signal.aborted ? "timeout" : "network");
    }

    if (!response.ok) {
      // The body is drained and discarded on purpose. It is the provider's text about our request,
      // and the status alone is what a caller can act on.
      await response.body?.cancel().catch(() => {});
      return fail(aiFailureForStatus(response.status), response.status);
    }

    let raw: string;
    try {
      raw = await readBoundedText(response, MAX_AI_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderResponseTooLarge) return fail("oversized_output");
      return fail(controller.signal.aborted ? "timeout" : "network");
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail("malformed_output"); }
    const extracted = extractAiText(parsed);
    if ("failure" in extracted) return fail(extracted.failure);

    return {
      connected: true,
      text: extracted.text,
      modelRef,
      providerRef: AI_PROVIDER_REF,
      latencyMs: Date.now() - started,
      stopReason: extracted.stopReason,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A real round trip, used to produce integration-readiness evidence. Returns what the registry needs
 * and nothing a prompt could hide in: no response text, only whether the provider answered, which
 * model was requested, and how long it took.
 */
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
  });
  const env = await runtimeEnv();
  const { modelRef } = aiModelRef(env);
  if (!result.connected) {
    return {
      verified: false,
      providerRef: result.failure === "not_configured" ? null : AI_PROVIDER_REF,
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
