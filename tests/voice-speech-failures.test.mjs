import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// STT and TTS failure handling, executed against both engines.
//
// Before this, the self-hosted adapter called bare fetch() with no timeout - an endpoint that accepted
// the connection and never answered held the request open - and `String(body.text ?? "")` turned any
// response shape at all into a transcript: `{}` became "", `{text: 42}` became "42", and an HTML error
// page parsed as nothing became a silent empty turn.
//
// Every case drives the real provider object. What is being asserted is the CLASSIFICATION, because that
// is what routes a mid-call failure to stt_failed / tts_failed rather than to a plausible-looking empty
// transcript. One distinction is deliberate: a provider that returns no transcript FIELD is broken
// (malformed_output); a provider that returns an empty transcript is answering truthfully about silence.
// ---------------------------------------------------------------------------

installWorkersHooks("__VSF_DB__", "__VSF_ENV__");
const engine = await import("../lib/voice-workers-ai.ts");
const adapter = await import("../lib/voice-provider-adapter.ts");
const voice = await import("../lib/ai-voice-uat.ts");
const { VoiceSpeechError } = await import("../lib/voice-speech-failures.ts");

const INLINE = "data:audio/mpeg;base64,AAECAw==";
const HTTP_ENV = { VOICE_STT_API_KEY: "k", VOICE_STT_URL: "https://stt.pawspace.in/x", VOICE_TTS_API_KEY: "k", VOICE_TTS_URL: "https://tts.pawspace.in/x", VOICE_SPEECH_TIMEOUT_MS: "1500" };
const code = async (fn) => { try { await fn(); return null; } catch (error) { assert.ok(error instanceof VoiceSpeechError, `expected VoiceSpeechError, got ${error}`); return error.code; } };

function withFetch(responder, run) {
  const original = globalThis.fetch;
  globalThis.fetch = responder;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}
// 1000ms is the shortest deadline speechTimeoutMs() will honour, so the timeout cases stay fast.
const ai = (run) => ({ AI: { run }, VOICE_SPEECH_TIMEOUT_MS: "1000" });

test("the disconnected stubs refuse rather than fabricating speech", async () => {
  assert.equal(voice.disconnectedStt.status, "not_connected");
  assert.equal(voice.disconnectedTts.status, "not_connected");
  await assert.rejects(() => voice.disconnectedStt.transcribe({ audioRef: INLINE }), /STT provider not connected/);
  await assert.rejects(() => voice.disconnectedTts.synthesize({ text: "hi" }), /TTS provider not connected/);
  // Selection falls through to them, so an unconfigured deployment cannot accidentally transcribe.
  assert.equal(adapter.selectVoiceStt({}).status, "not_connected");
  assert.equal(adapter.selectVoiceTts({}).status, "not_connected");
  assert.equal(adapter.voiceEngine({}), "none");
});

test("a first-party STT model that never answers hits the deadline", async () => {
  const stt = engine.resolveWorkersAiStt(ai(() => new Promise(() => {})));
  const started = Date.now();
  assert.equal(await code(() => stt.transcribe({ audioRef: INLINE })), "timeout");
  assert.ok(Date.now() - started < 5000, "returned on its own deadline instead of hanging");
});

test("a first-party STT model that answers with the wrong shape is malformed, not an empty transcript", async () => {
  for (const [result, expected] of [
    [{}, "malformed_output"],
    [{ transcription: null }, "malformed_output"],
    [{ text: 42 }, "malformed_output"],
    [{ text: { value: "hi" } }, "malformed_output"],
    [null, "malformed_output"],
    ["a string", "malformed_output"],
  ]) {
    const stt = engine.resolveWorkersAiStt(ai(async () => result));
    assert.equal(await code(() => stt.transcribe({ audioRef: INLINE })), expected, JSON.stringify(result));
  }
});

test("an empty transcript is a truthful answer about silence, flagged rather than thrown", async () => {
  const stt = engine.resolveWorkersAiStt(ai(async () => ({ text: "   " })));
  const result = await stt.transcribe({ audioRef: INLINE });
  assert.equal(result.text, "");
  assert.equal(result.confidence, 0, "no confidence is fabricated for silence");
  assert.equal(result.empty, true, "the caller can tell silence from a transcript");
});

test("a first-party STT model that throws is a classified provider failure", async () => {
  const stt = engine.resolveWorkersAiStt(ai(async () => { throw new Error("model unavailable"); }));
  assert.equal(await code(() => stt.transcribe({ audioRef: INLINE })), "provider_failure");
});

test("first-party TTS classifies timeout, empty, malformed and unusable audio separately", async () => {
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(() => new Promise(() => {}))).synthesize({ text: "hi" })), "timeout");
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => ({ audio: "" }))).synthesize({ text: "hi" })), "empty_output");
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => ({}))).synthesize({ text: "hi" })), "empty_output");
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => ({ audio: 12345 }))).synthesize({ text: "hi" })), "malformed_output");
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => { throw new Error("down"); })).synthesize({ text: "hi" })), "provider_failure");
  // A model returning something that is not base64 audio is caught here rather than handed onward as a
  // playable reference.
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => ({ audio: "!!!not-base64!!!" }))).synthesize({ text: "hi" })), "unsafe_audio");
  assert.equal(await code(() => engine.resolveWorkersAiTts(ai(async () => ({ audio: "AAEC" }))).synthesize({ text: "   " })), "malformed_output", "nothing to synthesise");
  const ok = await engine.resolveWorkersAiTts(ai(async () => ({ audio: "AAECAw==" }))).synthesize({ text: "hello" });
  assert.match(ok.audioRef, /^data:audio\/mpeg;base64,/);
});

test("the self-hosted STT endpoint is bounded by a real timeout", async () => {
  const stt = adapter.resolveVoiceStt(HTTP_ENV);
  const started = Date.now();
  const failure = await withFetch(
    (_url, init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }),
    () => code(() => stt.transcribe({ audioRef: INLINE })),
  );
  assert.equal(failure, "timeout");
  assert.ok(Date.now() - started < 5000);
});

test("the self-hosted endpoint's response shape is validated, not coerced", async () => {
  const stt = adapter.resolveVoiceStt(HTTP_ENV);
  const cases = [
    [() => new Response("<html>gateway error</html>", { status: 200 }), "malformed_output"],
    [() => Response.json([]), "malformed_output"],
    [() => Response.json({}), "malformed_output"],
    [() => Response.json({ text: 42 }), "malformed_output"],
    [() => new Response("nope", { status: 502 }), "provider_failure"],
    [() => { throw new Error("connection reset"); }, "provider_failure"],
  ];
  for (const [responder, expected] of cases) {
    assert.equal(await withFetch(async () => responder(), () => code(() => stt.transcribe({ audioRef: INLINE }))), expected);
  }
  const good = await withFetch(async () => Response.json({ text: "hello there", confidence: 0.8 }), () => stt.transcribe({ audioRef: INLINE }));
  assert.deepEqual({ text: good.text, confidence: good.confidence, empty: good.empty }, { text: "hello there", confidence: 0.8, empty: false });
});

test("the self-hosted TTS endpoint's audio result is validated before it is handed on", async () => {
  const tts = adapter.resolveVoiceTts(HTTP_ENV);
  for (const [responder, expected] of [
    [() => Response.json({}), "empty_output"],
    [() => Response.json({ audioRef: "" }), "empty_output"],
    [() => Response.json({ audioRef: 99 }), "malformed_output"],
    [() => Response.json({ audioRef: "http://media.pawspace.in/a.mp3" }), "unsafe_audio"],
    [() => Response.json({ audioRef: "https://127.0.0.1/a.mp3" }), "unsafe_audio"],
    [() => Response.json({ audioRef: "javascript:alert(1)" }), "unsafe_audio"],
    [() => new Response("boom", { status: 500 }), "provider_failure"],
  ]) {
    assert.equal(await withFetch(async () => responder(), () => code(() => tts.synthesize({ text: "hi" }))), expected);
  }
  const good = await withFetch(async () => Response.json({ audioRef: "https://media.pawspace.in/out.mp3" }), () => tts.synthesize({ text: "hi" }));
  assert.equal(good.audioRef, "https://media.pawspace.in/out.mp3");
});

test("the speech deadline is configurable but bounded", () => {
  assert.equal(engine.speechTimeoutMs({}), 12_000);
  assert.equal(engine.speechTimeoutMs({ VOICE_SPEECH_TIMEOUT_MS: "5000" }), 5000);
  // Outside the sane band, the default wins rather than an absurd value being honoured.
  for (const value of ["0", "10", "-1", "999999", "not-a-number", ""]) assert.equal(engine.speechTimeoutMs({ VOICE_SPEECH_TIMEOUT_MS: value }), 12_000, value);
});

test("a speech failure carries the stage it came from, so it can be routed to the right call state", async () => {
  const sttFailure = await engine.resolveWorkersAiStt(ai(async () => ({}))).transcribe({ audioRef: INLINE }).catch(error => error);
  assert.equal(sttFailure.stage, "stt");
  const ttsFailure = await engine.resolveWorkersAiTts(ai(async () => ({}))).synthesize({ text: "hi" }).catch(error => error);
  assert.equal(ttsFailure.stage, "tts");
});
