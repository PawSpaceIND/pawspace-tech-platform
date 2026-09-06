/**
 * Executed evidence for the AI provider boundary.
 *
 * Every case here drives the real `lib/ai-provider-adapter.ts` against a stubbed origin. That origin
 * is the only thing faked: no AI module is mocked, and each assertion is about a value the real
 * adapter returned. The failure branches - timeout, 4xx, 5xx, network, empty, malformed, oversized -
 * are the ones a source-text test cannot reach at all, and they are the ones that decide whether a
 * customer gets a human or a 500.
 *
 * The leakage cases are the reason `reason` is built from a fixed vocabulary: a provider error body is
 * the provider's description of OUR request, so echoing it puts prompt text (and whatever context the
 * prompt carried) into staff screens and audit rows that are kept indefinitely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, stubFetch, jsonResponse, slowBodyResponse, oversizedResponse, UAT_AI_ENV } from "./helpers/ai-harness.mjs";

installAiHooks();

function withEnv(extra = {}) {
  globalThis.__PAWSPACE_TEST_ENV__ = { ...UAT_AI_ENV, ...extra };
}
const adapter = await import("../lib/ai-provider-adapter.ts");

const textBody = (text, stopReason = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] });

// ---------------------------------------------------------------------------
// Normal output
// ---------------------------------------------------------------------------
test("a normal provider answer returns its text, the requested model and a measured latency", async () => {
  withEnv();
  const stub = stubFetch(() => jsonResponse(textBody("Grooming starts at Rs 899.")));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "how much is grooming?" });
    assert.equal(result.connected, true);
    assert.equal(result.text, "Grooming starts at Rs 899.");
    assert.equal(result.providerRef, "anthropic");
    assert.equal(result.modelRef, adapter.DEFAULT_AI_MODEL_REF);
    assert.equal(result.stopReason, "end_turn");
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.equal(stub.calls.length, 1);
    const sent = JSON.parse(stub.calls[0].init.body);
    assert.equal(sent.model, adapter.DEFAULT_AI_MODEL_REF, "the model actually sent is the one reported");
  } finally { stub.restore(); }
});

test("the model is configurable and the configured value is the one actually requested", async () => {
  withEnv({ PAWSPACE_AI_PROVIDER_MODEL: "claude-sonnet-5" });
  const stub = stubFetch(() => jsonResponse(textBody("ok")));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.modelRef, "claude-sonnet-5");
    assert.equal(JSON.parse(stub.calls[0].init.body).model, "claude-sonnet-5");
  } finally { stub.restore(); }
});

test("max_tokens is bounded on both sides so a caller cannot ask for an unbounded generation", async () => {
  withEnv();
  const stub = stubFetch(() => jsonResponse(textBody("ok")));
  try {
    await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi", maxTokens: 10_000_000 });
    assert.equal(JSON.parse(stub.calls[0].init.body).max_tokens, 8_000);
    await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi", maxTokens: 0 });
    assert.equal(JSON.parse(stub.calls[1].init.body).max_tokens, 2_000, "0 is not a usable budget - it falls back to the default");
    await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi", maxTokens: Number.NaN });
    assert.equal(JSON.parse(stub.calls[2].init.body).max_tokens, 2_000);
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// No provider configured
// ---------------------------------------------------------------------------
test("with no credential the adapter refuses without any network call at all", async () => {
  globalThis.__PAWSPACE_TEST_ENV__ = {};
  const stub = stubFetch(() => { throw new Error("the adapter must not reach the network without a credential"); });
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.connected, false);
    assert.equal(result.failure, "not_configured");
    assert.equal(result.retryable, false, "a missing credential will not fix itself on retry");
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("credential presence is reported as configuration, never as a verified provider or a verified model", async () => {
  globalThis.__PAWSPACE_TEST_ENV__ = {};
  const absent = await adapter.aiProviderConnection();
  assert.equal(absent.configured, false);
  assert.equal(absent.connected, false);
  assert.equal(absent.modelRef, null);

  withEnv();
  const present = await adapter.aiProviderConnection();
  assert.equal(present.configured, true);
  assert.equal(present.verified, false, "a key on disk is not evidence that a model answered");
  assert.equal(present.modelRefSource, "default");
  assert.match(present.reason, /not a model confirmed to have answered/);
});

// ---------------------------------------------------------------------------
// Empty and malformed output
// ---------------------------------------------------------------------------
test("empty and whitespace-only answers are refused rather than passed on as a reply", async () => {
  withEnv();
  for (const body of [textBody(""), textBody("   \n\t "), { type: "message", content: [] }]) {
    const stub = stubFetch(() => jsonResponse(body));
    try {
      const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
      assert.equal(result.connected, false, `expected refusal for ${JSON.stringify(body).slice(0, 60)}`);
      assert.equal(result.failure, "empty_output");
      assert.equal(result.retryable, false);
    } finally { stub.restore(); }
  }
});

test("a malformed 200 body is a classified refusal, not a thrown exception", async () => {
  // `null` is the case that used to crash: `(body.content || [])` on a null body throws a TypeError,
  // which surfaced as a generic 500 rather than a handoff.
  withEnv();
  const malformed = ["null", "[]", '"a string"', "{}", '{"content":"not-an-array"}', '{"content":[{"type":"text"}]}', "not json at all", '{"content":[null,7]}'];
  for (const raw of malformed) {
    const stub = stubFetch(() => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
      assert.equal(result.connected, false, `expected refusal for ${raw}`);
      assert.ok(["malformed_output", "empty_output"].includes(result.failure), `${raw} produced ${result.failure}`);
    } finally { stub.restore(); }
  }
});

test("a provider error object returned with HTTP 200 is treated as an error, not as empty text", async () => {
  withEnv();
  const stub = stubFetch(() => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.failure, "provider_error");
    assert.equal(result.retryable, true);
  } finally { stub.restore(); }
});

test("only text blocks contribute, and a non-string text field cannot become part of the reply", async () => {
  withEnv();
  const stub = stubFetch(() => jsonResponse({
    type: "message",
    content: [{ type: "thinking", text: "internal reasoning" }, { type: "text", text: "visible" }, { type: "text", text: { nested: true } }],
  }));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.connected, true);
    assert.equal(result.text, "visible", "a thinking block is not customer-facing text");
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------
test("HTTP status maps onto retryable and terminal failures the caller can act on", async () => {
  withEnv();
  const expected = [[400, "client_error", false], [401, "client_error", false], [403, "client_error", false], [404, "client_error", false], [422, "client_error", false], [429, "rate_limited", true], [500, "provider_error", true], [502, "provider_error", true], [503, "provider_error", true]];
  for (const [status, failure, retryable] of expected) {
    const stub = stubFetch(() => jsonResponse({ error: { message: "provider says something" } }, status));
    try {
      const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
      assert.equal(result.connected, false);
      assert.equal(result.failure, failure, `HTTP ${status}`);
      assert.equal(result.retryable, retryable, `HTTP ${status} retryable`);
      assert.equal(result.status, status, "the numeric status is kept - it is safe and it is what an operator needs");
    } finally { stub.restore(); }
  }
});

test("a network failure is classified as network, and is retryable", async () => {
  withEnv();
  const stub = stubFetch(() => { throw new TypeError("fetch failed"); });
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.failure, "network");
    assert.equal(result.retryable, true);
  } finally { stub.restore(); }
});

test("a provider that never answers hits the deadline instead of holding the request open", async () => {
  withEnv({ PAWSPACE_AI_PROVIDER_TIMEOUT_MS: "1000" });
  const stub = stubFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  try {
    const started = Date.now();
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.failure, "timeout");
    assert.equal(result.retryable, true);
    assert.ok(Date.now() - started < 5_000, "the deadline actually fired rather than the test timing out");
  } finally { stub.restore(); }
});

test("headers arriving in time does not buy an unbounded body: the deadline covers the read", async () => {
  // This is the case an `AbortController` released straight after `await fetch` cannot catch. A
  // provider that answers with headers and then trickles bytes was unbounded again.
  withEnv({ PAWSPACE_AI_PROVIDER_TIMEOUT_MS: "1000" });
  const stub = stubFetch((_url, init) => slowBodyResponse(JSON.stringify(textBody("too late")), 30_000, init.signal));
  try {
    const started = Date.now();
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.connected, false);
    assert.ok(["timeout", "network"].includes(result.failure), `body stall produced ${result.failure}`);
    assert.ok(Date.now() - started < 10_000, "the read was bounded by the same deadline as the handshake");
  } finally { stub.restore(); }
});

test("the configured deadline is clamped, so neither a typo nor a hostile value removes it", async () => {
  for (const [configured, effective] of [["0", 30_000], ["-5", 30_000], ["abc", 30_000], ["", 30_000], ["10", 1_000], ["999999999", 120_000], ["5000", 5_000]]) {
    withEnv({ PAWSPACE_AI_PROVIDER_TIMEOUT_MS: configured });
    const connection = await adapter.aiProviderConnection();
    assert.equal(connection.timeoutMs, effective, `PAWSPACE_AI_PROVIDER_TIMEOUT_MS=${JSON.stringify(configured)}`);
  }
});

test("an oversized body is refused after the cap rather than buffered whole", async () => {
  withEnv({ PAWSPACE_AI_PROVIDER_TIMEOUT_MS: "20000" });
  const stub = stubFetch(() => oversizedResponse(adapter.MAX_AI_RESPONSE_BYTES + 1_000));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.failure, "oversized_output");
    assert.equal(result.retryable, false, "the same oversized answer will arrive again");
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// Leakage
// ---------------------------------------------------------------------------
test("no failure reason can carry provider text, prompt text or the credential", async () => {
  withEnv();
  const SECRET_PROMPT = "PROMPT-CANARY-do-not-leak";
  const PROVIDER_BODY = "PROVIDER-CANARY: your request was {\"system\":\"PROMPT-CANARY-do-not-leak\"} and key sk-ant-CANARY";
  const cases = [
    () => jsonResponse(PROVIDER_BODY, 400),
    () => jsonResponse(PROVIDER_BODY, 500),
    () => jsonResponse(PROVIDER_BODY, 429),
    () => new Response(PROVIDER_BODY, { status: 200 }),
    () => { throw new Error(PROVIDER_BODY); },
  ];
  for (const handler of cases) {
    const stub = stubFetch(handler);
    try {
      const result = await adapter.requestAiDraft({ systemPrompt: SECRET_PROMPT, userPrompt: SECRET_PROMPT, maxTokens: 100 });
      assert.equal(result.connected, false);
      const serialised = JSON.stringify(result);
      assert.ok(!serialised.includes("PROVIDER-CANARY"), `provider body leaked into ${serialised}`);
      assert.ok(!serialised.includes("PROMPT-CANARY"), `prompt leaked into ${serialised}`);
      assert.ok(!serialised.includes("sk-ant-"), `credential leaked into ${serialised}`);
      assert.ok(!serialised.includes(UAT_AI_ENV.PAWSPACE_AI_PROVIDER_API_KEY), "credential leaked into the reason");
    } finally { stub.restore(); }
  }
});

test("every failure reason comes from the adapter's own fixed vocabulary", async () => {
  withEnv();
  const seen = new Set();
  const handlers = [
    () => jsonResponse("x", 400), () => jsonResponse("x", 429), () => jsonResponse("x", 503),
    () => { throw new Error("boom"); }, () => jsonResponse(textBody("")), () => new Response("null", { status: 200 }),
  ];
  for (const handler of handlers) {
    const stub = stubFetch(handler);
    try {
      const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
      seen.add(result.failure);
      // The only variable admitted into a reason is a numeric status.
      assert.match(result.reason, /^[A-Za-z0-9 ,'"_\-.()]+$/, result.reason);
      assert.doesNotMatch(result.reason, /\{|\}|\[|\]/, "no structured provider payload in a reason");
    } finally { stub.restore(); }
  }
  assert.ok(seen.size >= 5, `expected several distinct failure classes, saw ${[...seen].join(", ")}`);
});

test("the credential travels in the header and never in the URL or the body", async () => {
  withEnv();
  const stub = stubFetch(() => jsonResponse(textBody("ok")));
  try {
    await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    const call = stub.calls[0];
    assert.equal(call.init.headers["x-api-key"], UAT_AI_ENV.PAWSPACE_AI_PROVIDER_API_KEY);
    assert.ok(!call.url.includes(UAT_AI_ENV.PAWSPACE_AI_PROVIDER_API_KEY), "a key in a URL ends up in every access log on the path");
    assert.ok(!String(call.init.body).includes(UAT_AI_ENV.PAWSPACE_AI_PROVIDER_API_KEY));
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// Retry and verification
// ---------------------------------------------------------------------------
test("retryable classification lets a caller retry a rate-limit and succeed, and stop on a 400", async () => {
  withEnv();
  let attempt = 0;
  const stub = stubFetch(() => (attempt++ === 0 ? jsonResponse("slow down", 429) : jsonResponse(textBody("second time lucky"))));
  try {
    let result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.retryable, true);
    result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(result.connected, true);
    assert.equal(result.text, "second time lucky");
  } finally { stub.restore(); }

  const terminal = stubFetch(() => jsonResponse("bad request", 400));
  try {
    const result = await adapter.requestAiDraft({ systemPrompt: "sys", userPrompt: "hi" });
    assert.equal(adapter.isRetryableAiFailure(result.failure), false, "a caller that retries a 400 forever is the bug this classification prevents");
  } finally { terminal.restore(); }
});

test("verifyAiProvider produces evidence with no response text in it, and refuses to claim success on failure", async () => {
  withEnv();
  const ok = stubFetch(() => jsonResponse(textBody("OK")));
  try {
    const evidence = await adapter.verifyAiProvider();
    assert.equal(evidence.verified, true);
    assert.equal(evidence.providerRef, "anthropic");
    assert.equal(evidence.modelRefRequested, adapter.DEFAULT_AI_MODEL_REF);
    assert.ok(Number.isInteger(evidence.checkedAt) && evidence.checkedAt > 0, "evidence carries a timestamp");
    assert.ok(!JSON.stringify(evidence).includes("OK\""), "the probe response text is not part of the evidence");
  } finally { ok.restore(); }

  const broken = stubFetch(() => jsonResponse("nope", 500));
  try {
    const evidence = await adapter.verifyAiProvider();
    assert.equal(evidence.verified, false);
    assert.equal(evidence.failure, "provider_error");
    assert.equal(evidence.latencyMs, null);
  } finally { broken.restore(); }

  globalThis.__PAWSPACE_TEST_ENV__ = {};
  const unconfigured = stubFetch(() => { throw new Error("must not be called"); });
  try {
    const evidence = await adapter.verifyAiProvider();
    assert.equal(evidence.verified, false);
    assert.equal(evidence.failure, "not_configured");
    assert.equal(evidence.providerRef, null, "an unconfigured provider is not attributed to a vendor");
  } finally { unconfigured.restore(); }
});
