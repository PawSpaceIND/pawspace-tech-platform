#!/usr/bin/env node

const args = process.argv.slice(2);
const readArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] ?? "").trim() : "";
};

const token = readArg("--token");
const baseUrl = (readArg("--base-url") || process.env.STAGING_URL || "").replace(/\/$/, "");
if (!token || !token.includes("=") || /[\r\n]/.test(token)) {
  console.error("staging voice auth: --token must be a single temporary session cookie pair");
  process.exit(2);
}
if (!/^https:\/\//.test(baseUrl)) {
  console.error("staging voice auth: --base-url (or STAGING_URL) must be an https staging origin");
  process.exit(2);
}

const request = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      cookie: token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = String(parsed?.error || parsed?.message || `HTTP ${response.status}`);
    throw new Error(`${method} ${path} failed: ${message}`);
  }
  return parsed;
};

const status = await request("GET", "/api/voice-speech");
const voice = status?.data ?? {};
if (voice.engine !== "workers_ai" || voice.firstParty !== true || voice.workersAiBindingPresent !== true) {
  throw new Error(`voice engine is not first-party Workers AI (engine=${String(voice.engine || "unknown")})`);
}
if (voice?.stt?.status !== "connected" || voice?.tts?.status !== "connected") {
  throw new Error(`voice providers are not connected (stt=${String(voice?.stt?.status)}, tts=${String(voice?.tts?.status)})`);
}

const phrase = "PawSpace authenticated staging voice verification";
const synthesized = await request("POST", "/api/voice-speech", {
  action: "synthesize",
  text: phrase,
  language: "en",
});
const audioRef = String(synthesized?.data?.audioRef || "");
const prefix = "data:audio/mpeg;base64,";
if (!audioRef.startsWith(prefix)) throw new Error("MeloTTS did not return an inline MPEG audio reference");
const audioBytes = Buffer.from(audioRef.slice(prefix.length), "base64");
if (audioBytes.length < 128) throw new Error(`MeloTTS audio output is unexpectedly small (${audioBytes.length} bytes)`);

const transcribed = await request("POST", "/api/voice-speech", {
  action: "transcribe",
  audioRef,
  language: "en",
});
const transcript = String(transcribed?.data?.text || "").trim();
if (!transcript) throw new Error("Whisper returned an empty transcript for MeloTTS-generated speech");

console.log(JSON.stringify({
  ok: true,
  engine: voice.engine,
  firstParty: voice.firstParty,
  workersAiBindingPresent: voice.workersAiBindingPresent,
  stt: { provider: voice?.stt?.provider, status: voice?.stt?.status, transcript, latencyMs: transcribed?.data?.latencyMs },
  tts: { provider: voice?.tts?.provider, status: voice?.tts?.status, audioBytes: audioBytes.length, latencyMs: synthesized?.data?.latencyMs },
}, null, 2));
console.log("Audio Bot STT/TTS UAT — CLOSED ✅");
