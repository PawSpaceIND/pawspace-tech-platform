import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// SSRF and audio-safety, executed against the real guard.
//
// An audioRef reaches this code from outside: a caller posting to /api/voice-speech, an STT/TTS vendor
// response, a telephony recording callback. Dereferencing one with a bare fetch() turns the Worker into
// a request forwarder INSIDE the network perimeter, and the highest-value target on a cloud runtime is
// the instance metadata service - unauthenticated HTTP that answers with credentials.
//
// The guard that shipped covered one path, matched private ranges as string prefixes, and then called
// plain fetch(), which follows redirects: an allowlisted host answering 302 -> http://169.254.169.254/
// walked straight past it. It had no timeout, no size bound and no media-type check.
//
// Nothing here asserts on source text. Every case drives assertSafeVoiceUrl / safeVoiceFetch /
// decodeInlineAudio with an injected transport and asserts on the refusal AND, where it matters, that
// the transport was never called at all.
// ---------------------------------------------------------------------------

installWorkersHooks("__VSSRF_DB__", "__VSSRF_ENV__");
const safe = await import("../lib/voice-safe-fetch.ts");
const { assertSafeVoiceUrl, safeVoiceFetch, decodeInlineAudio, isBlockedVoiceHost, VoiceFetchRefused } = safe;

const ALLOWED = ["media.pawspace.in"];
const refusal = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof VoiceFetchRefused, `expected VoiceFetchRefused, got ${error}`); return error; } };

// A transport that records every URL it is asked for. If a guard leaks, calls.length proves it.
function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => { calls.push(String(url)); return responder(String(url), init, calls.length); };
  return { impl, calls };
}
const body = (bytes, headers) => new Response(bytes, { status: 200, headers });

test("every private, loopback, link-local and metadata destination is refused before any request", () => {
  const hostile = [
    "https://localhost/audio.mp3",
    "https://localhost.localdomain/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://127.1.2.3/a.mp3",                 // all of 127/8, not just .0.1
    "https://0.0.0.0/a.mp3",
    "https://[::1]/a.mp3",
    "https://[::]/a.mp3",
    "https://[::ffff:127.0.0.1]/a.mp3",        // IPv4-mapped loopback (the URL parser rewrites this to ::ffff:7f00:1)
    "https://[::ffff:7f00:1]/a.mp3",           // ...and the already-normalised form
    "https://[::ffff:169.254.169.254]/x",      // IPv4-mapped IMDS
    "https://[::ffff:10.0.0.1]/a.mp3",         // IPv4-mapped RFC1918
    "https://[::127.0.0.1]/a.mp3",             // IPv4-compatible loopback
    "https://[64:ff9b::169.254.169.254]/x",    // NAT64-embedded IMDS
    "https://[fd00:ec2::254]/x",               // AWS IMDS over IPv6
    "https://[ff02::1]/a.mp3",                 // IPv6 multicast
    "https://[fc00::1]/a.mp3",                 // start of fc00::/7
    "https://[fd00::1]/a.mp3",                 // unique local
    "https://[fe80::1]/a.mp3",                 // IPv6 link-local
    "https://10.0.0.5/a.mp3",
    "https://10.255.255.255/a.mp3",
    "https://172.16.0.1/a.mp3",
    "https://172.31.255.254/a.mp3",
    "https://192.168.1.1/a.mp3",
    "https://169.254.1.1/a.mp3",               // link-local
    "https://169.254.169.254/latest/meta-data/", // AWS/GCP/Azure IMDS
    "https://169.254.170.2/v2/credentials",    // ECS task metadata
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://metadata.goog/x",
    "https://metadata/x",
    "https://metadata.azure.com/x",
    "https://100.100.100.200/latest/meta-data/", // Alibaba metadata
    "https://100.64.0.1/a.mp3",                // carrier NAT
    "https://redis.internal/a.mp3",
    "https://printer.local/a.mp3",
    "https://api.svc.cluster.local/a.mp3",
    "https://db.lan/a.mp3",
    "https://x.home.arpa/a.mp3",
    "https://2130706433/a.mp3",                // decimal-encoded 127.0.0.1
    "https://0x7f.0x0.0x0.0x1/a.mp3",          // hex-encoded loopback
  ];
  for (const url of hostile) {
    const error = refusal(() => assertSafeVoiceUrl(url));
    assert.ok(error, `${url} must be refused`);
    assert.ok(["private_host", "invalid_url"].includes(error.code), `${url} refused as ${error.code}`);
  }
  // 172.15 and 172.32 are PUBLIC - a prefix-matching guard gets this range wrong in both directions.
  for (const ok of ["https://172.15.0.1/a.mp3", "https://172.32.0.1/a.mp3", "https://100.63.0.1/a.mp3", "https://100.128.0.1/a.mp3", "https://11.0.0.1/a.mp3"]) {
    assert.doesNotThrow(() => assertSafeVoiceUrl(ok), `${ok} is public and must be allowed`);
  }
});

test("isBlockedVoiceHost is bounded by range, not by string prefix", () => {
  assert.equal(isBlockedVoiceHost("169.254.169.254"), true);
  assert.equal(isBlockedVoiceHost("169.255.0.1"), false);
  assert.equal(isBlockedVoiceHost("172.16.0.0"), true);
  assert.equal(isBlockedVoiceHost("172.15.255.255"), false);
  assert.equal(isBlockedVoiceHost("METADATA.GOOGLE.INTERNAL"), true, "case-insensitive");
  assert.equal(isBlockedVoiceHost("metadata.google.internal."), true, "trailing dot does not evade");
  assert.equal(isBlockedVoiceHost(""), true, "an empty host is refused, not allowed");
  // IPv6 has to be parsed, not prefix-matched: these two differ only in the embedded IPv4 address.
  assert.equal(isBlockedVoiceHost("[::ffff:7f00:1]"), true, "::ffff:127.0.0.1");
  assert.equal(isBlockedVoiceHost("[::ffff:808:808]"), false, "::ffff:8.8.8.8 is public");
  assert.equal(isBlockedVoiceHost("[2001:4860:4860::8888]"), false, "a public IPv6 resolver is allowed");
});

test("only https is dereferenced, and credentials may not be smuggled in the URL", () => {
  for (const [url, code] of [
    ["http://media.pawspace.in/a.mp3", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["gopher://media.pawspace.in/a", "unsupported_scheme"],
    ["ftp://media.pawspace.in/a.mp3", "unsupported_scheme"],
    ["ws://media.pawspace.in/a", "unsupported_scheme"],
    ["https://user:pass@media.pawspace.in/a.mp3", "credentials_in_url"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
  ]) assert.equal(refusal(() => assertSafeVoiceUrl(url))?.code, code, url);
});

test("an allow-list, when configured, is the outer bound", () => {
  assert.doesNotThrow(() => assertSafeVoiceUrl("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED }));
  assert.equal(refusal(() => assertSafeVoiceUrl("https://evil.example/a.mp3", { allowedHosts: ALLOWED }))?.code, "host_not_allowlisted");
});

test("a redirect to a private destination is refused at the hop, not followed", async () => {
  // The exact bypass the previous guard had: the first URL is allowlisted and public, and the response
  // redirects onto the metadata service.
  const { impl, calls } = recordingFetch(async (url) => url.includes("media.pawspace.in")
    ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } })
    : body(new Uint8Array([1, 2, 3]), { "content-type": "audio/mpeg" }));
  await assert.rejects(
    () => safeVoiceFetch("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED, fetchImpl: impl }),
    (error) => error instanceof VoiceFetchRefused && error.code === "private_host",
  );
  assert.deepEqual(calls, ["https://media.pawspace.in/a.mp3"], "the metadata host was never requested");
});

test("a redirect off the allow-list is refused even when the destination is public", async () => {
  const { impl, calls } = recordingFetch(async (url) => url.includes("media.pawspace.in")
    ? new Response(null, { status: 301, headers: { location: "https://exfil.example/collect" } })
    : body(new Uint8Array([1]), { "content-type": "audio/mpeg" }));
  await assert.rejects(
    () => safeVoiceFetch("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED, fetchImpl: impl }),
    (error) => error.code === "host_not_allowlisted",
  );
  assert.equal(calls.length, 1);
});

test("a relative redirect is resolved and re-validated, and a redirect loop is bounded", async () => {
  const okHop = recordingFetch(async (url, _init, n) => n === 1
    ? new Response(null, { status: 307, headers: { location: "/final.mp3" } })
    : body(new Uint8Array([9]), { "content-type": "audio/mpeg" }));
  const resolved = await safeVoiceFetch("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED, fetchImpl: okHop.impl });
  assert.equal(resolved.url, "https://media.pawspace.in/final.mp3");
  assert.deepEqual(okHop.calls, ["https://media.pawspace.in/a.mp3", "https://media.pawspace.in/final.mp3"]);

  const loop = recordingFetch(async () => new Response(null, { status: 302, headers: { location: "https://media.pawspace.in/again.mp3" } }));
  await assert.rejects(
    () => safeVoiceFetch("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED, fetchImpl: loop.impl, maxRedirects: 2 }),
    (error) => error.code === "too_many_redirects",
  );
  assert.equal(loop.calls.length, 3, "bounded at maxRedirects + the original request");

  const headless = recordingFetch(async () => new Response(null, { status: 302 }));
  await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a.mp3", { allowedHosts: ALLOWED, fetchImpl: headless.impl }), (error) => error.code === "bad_redirect");
});

test("a payload that is not audio is refused rather than fed to a model", async () => {
  for (const [contentType, code] of [["text/html", "invalid_media_type"], ["application/json", "invalid_media_type"], ["", "invalid_media_type"]]) {
    const { impl } = recordingFetch(async () => body(new Uint8Array([1]), contentType ? { "content-type": contentType } : {}));
    await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: impl }), (error) => error.code === code, contentType);
  }
  const { impl } = recordingFetch(async () => body(new Uint8Array([1]), { "content-type": "audio/wav; charset=binary" }));
  const ok = await safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: impl });
  assert.equal(ok.mediaType, "audio/wav", "a parameterised audio content-type is accepted");
});

test("an oversized payload is refused - by declared length AND by what actually arrives", async () => {
  const declared = recordingFetch(async () => body(new Uint8Array(4), { "content-type": "audio/mpeg", "content-length": "99999999" }));
  await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: declared.impl, maxBytes: 1024 }), (error) => error.code === "too_large");

  // content-length is a claim. A server that under-declares, or sends no length at all, must still be
  // capped - otherwise the bound is advisory.
  const lying = recordingFetch(async () => body(new Uint8Array(4096), { "content-type": "audio/mpeg", "content-length": "4" }));
  await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: lying.impl, maxBytes: 1024 }), (error) => error.code === "too_large");

  const unbounded = recordingFetch(async () => body(new Uint8Array(4096), { "content-type": "audio/mpeg" }));
  await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: unbounded.impl, maxBytes: 1024 }), (error) => error.code === "too_large");

  const within = recordingFetch(async () => body(new Uint8Array(512), { "content-type": "audio/mpeg", "content-length": "512" }));
  const fetched = await safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: within.impl, maxBytes: 1024 });
  assert.equal(fetched.bytes.byteLength, 512);
});

test("a host that accepts the connection and never answers hits the deadline", async () => {
  const impl = (url, init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
  const started = Date.now();
  await assert.rejects(
    () => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: impl, timeoutMs: 120 }),
    (error) => error instanceof VoiceFetchRefused && error.code === "timeout",
  );
  assert.ok(Date.now() - started < 3000, "the guard returned on its own deadline rather than hanging");
});

test("a non-2xx upstream is a refusal, not an empty transcript", async () => {
  const { impl } = recordingFetch(async () => new Response("nope", { status: 404, headers: { "content-type": "audio/mpeg" } }));
  await assert.rejects(() => safeVoiceFetch("https://media.pawspace.in/a", { allowedHosts: ALLOWED, fetchImpl: impl }), (error) => error.code === "http_error");
});

test("inline audio is bounded and type-checked the same way a fetched body is", () => {
  const small = decodeInlineAudio("data:audio/mpeg;base64,AAECAw==");
  assert.equal(small.mediaType, "audio/mpeg");
  assert.deepEqual([...small.bytes], [0, 1, 2, 3]);

  assert.equal(refusal(() => decodeInlineAudio("data:text/html;base64,PGh0bWw+"))?.code, "invalid_media_type");
  assert.equal(refusal(() => decodeInlineAudio("data:audio/mpeg,not-base64"))?.code, "invalid_media_type", "unencoded inline audio is refused");
  assert.equal(refusal(() => decodeInlineAudio("data:audio/mpeg;base64,!!!!"))?.code, "invalid_payload");
  assert.equal(refusal(() => decodeInlineAudio("https://media.pawspace.in/a.mp3"))?.code, "invalid_url");
  const big = `data:audio/mpeg;base64,${"A".repeat(4096)}`;
  assert.equal(refusal(() => decodeInlineAudio(big, { maxBytes: 128 }))?.code, "too_large");
});

test("the first-party STT engine never dereferences a hostile audioRef", async () => {
  // Drives the real resolveWorkersAiStt against a fake AI binding, with globalThis.fetch replaced by a
  // recorder - so "was the metadata service contacted" is answered by observation, not by reading code.
  const engine = await import("../lib/voice-workers-ai.ts");
  const speech = await import("../lib/voice-speech-failures.ts");
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(String(url)); return body(new Uint8Array([1]), { "content-type": "audio/mpeg" }); };
  try {
    let modelCalls = 0;
    const stt = engine.resolveWorkersAiStt({ AI: { run: async () => { modelCalls++; return { text: "hello" }; } }, VOICE_AUDIO_ALLOWED_HOSTS: "media.pawspace.in" });
    for (const hostile of ["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/a.mp3", "http://media.pawspace.in/a.mp3", "https://evil.example/a.mp3"]) {
      await assert.rejects(
        () => stt.transcribe({ audioRef: hostile }),
        (error) => error instanceof speech.VoiceSpeechError && error.code === "unsafe_audio",
        hostile,
      );
    }
    assert.deepEqual(seen, [], "no hostile audioRef was ever fetched");
    assert.equal(modelCalls, 0, "and no audio was handed to the model");

    // The allowlisted host still works, so the guard is a bound and not a blanket refusal.
    const good = await stt.transcribe({ audioRef: "https://media.pawspace.in/ok.mp3" });
    assert.equal(good.text, "hello");
    assert.deepEqual(seen, ["https://media.pawspace.in/ok.mp3"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("the self-hosted STT/TTS adapter applies the same guard, in both directions", async () => {
  const adapter = await import("../lib/voice-provider-adapter.ts");
  const speech = await import("../lib/voice-speech-failures.ts");
  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posted.push(String(url)); return Response.json(JSON.parse(String(init.body))); };
  try {
    const env = { VOICE_STT_API_KEY: "k", VOICE_STT_URL: "https://stt.pawspace.in/transcribe", VOICE_TTS_API_KEY: "k", VOICE_TTS_URL: "https://tts.pawspace.in/speak", VOICE_AUDIO_ALLOWED_HOSTS: "media.pawspace.in" };
    // INBOUND: a caller-supplied audioRef is refused before the provider is even asked, so the SSRF is
    // not simply relocated one hop out to a self-hosted endpoint.
    const stt = adapter.resolveVoiceStt(env);
    await assert.rejects(() => stt.transcribe({ audioRef: "https://169.254.169.254/latest/meta-data/" }), (error) => error.code === "unsafe_audio");
    assert.deepEqual(posted, [], "the STT endpoint was never called with a hostile reference");

    // OUTBOUND: a provider handing back a hostile audioRef is refused too - it would otherwise be
    // played, re-fetched or forwarded downstream.
    globalThis.fetch = async () => Response.json({ audioRef: "https://169.254.169.254/latest/meta-data/" });
    const tts = adapter.resolveVoiceTts(env);
    await assert.rejects(() => tts.synthesize({ text: "hello" }), (error) => error instanceof speech.VoiceSpeechError && error.code === "unsafe_audio");
  } finally { globalThis.fetch = originalFetch; }
});
