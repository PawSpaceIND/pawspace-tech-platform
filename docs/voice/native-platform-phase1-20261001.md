# Maya native voice platform — Phase 1

Date: 2026-10-01

## Goal

Move real-time phone conversation ownership into PawSpace while keeping vendor speech engines replaceable.

The native path is:

Exotel AgentStream → PawSpace Worker → Cloudflare Whisper STT → Maya/Atlas governed conversation → replaceable TTS → Exotel AgentStream.

ElevenLabs is no longer required to own turn-taking, memory, CRM context, booking authority or call state on this path. It can be used only as a direct speech renderer and can be replaced or bypassed without changing Maya's conversation logic.

## PawSpace-owned authority

- canonical customer, lead, booking and thread identity
- knowledge retrieval, sales policy and conversation memory
- turn timing, barge-in and playback marks
- consent, opt-out, quiet-hours and frequency-cap policy
- booking and scheduling permissions
- human handoff, CRM disposition and retry termination
- transcript/event ledger and quality telemetry

## Replaceable infrastructure

- Telephone carrier: Exotel
- STT: Cloudflare Workers AI Whisper, currently `@cf/openai/whisper-large-v3-turbo`
- TTS primary: configurable with `PAWSPACE_VOICE_NATIVE_TTS_PROVIDER`
- Direct premium TTS option: ElevenLabs Text-to-Speech API, default model `eleven_flash_v2_5`
- TTS fallback: configurable with `PAWSPACE_VOICE_NATIVE_TTS_FALLBACK`; Workers AI is the default fallback in controlled UAT when available

Direct ElevenLabs TTS requires only the TTS credential and voice ID for the native renderer. It does not use an ElevenLabs conversational agent.

## Safety and rollout

Phase 1 does not switch the ordinary production voice runtime. Existing ElevenLabs-agent routing stays intact while the native AgentStream path is tested under the existing UAT controls and allowlist.

An explicit `PAWSPACE_VOICE_RUNTIME=native` is fail-closed unless the Exotel credentials and a governed `wss:` AgentStream URL are present. Unknown runtime values do not silently select another provider.

The native TTS selector fails closed on unknown provider names and unapproved ElevenLabs API origins. ElevenLabs credentials and voice IDs remain encrypted Worker secrets and are never serialized into wrangler vars.

No workflow introduced by this phase places a call automatically.

## Measurement

Every native turn records bounded, PII-safe timing metadata:

- STT model and latency
- Maya/LLM latency
- TTS provider, model and latency
- whether TTS fallback was used
- total turn latency and whether the latency target was met
- audio duration plus transcript/assistant character counts, never transcript text

This lets UAT compare the same Maya flow with direct ElevenLabs TTS and Workers AI TTS on recognition accuracy, response delay, interruptions, naturalness, booking correctness and cost per completed call.

## Phase 2 gate

Do not make `PAWSPACE_VOICE_RUNTIME=native` the ordinary production default until controlled phone UAT proves:

1. stable Exotel bidirectional audio;
2. acceptable Whisper accuracy for the intended languages;
3. natural TTS quality;
4. barge-in and handoff reliability;
5. booking/CRM correctness; and
6. measured call economics against the current ElevenLabs-agent path.
