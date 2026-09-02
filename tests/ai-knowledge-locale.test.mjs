import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_AI_LOCALE,
  isLocale,
  normalizeLocale,
  speechLanguageCode,
  supportedLocales,
} from "../lib/ai-locale.ts";
import { buildBleuAiWorkerRequest, buildExotelAiRequest } from "../lib/voice-provider-adapter.ts";

const ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("locale registry is canonical and deterministic", () => {
  assert.equal(DEFAULT_AI_LOCALE, "en-IN");
  assert.deepEqual(supportedLocales, ["en-IN", "hi-IN", "kn-IN"]);
  assert.equal(normalizeLocale("EN_in"), "en-IN");
  assert.equal(normalizeLocale("hi"), "hi-IN");
  assert.equal(normalizeLocale("kn-in"), "kn-IN");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(isLocale("en-IN"), true);
  assert.equal(isLocale("en-us"), false);
  assert.equal(speechLanguageCode("en-IN"), "en-IN");
  assert.equal(speechLanguageCode("hi-IN"), "hi-IN");
  assert.equal(speechLanguageCode("kn-IN"), "kn-IN");
});

test("knowledge retrieval only returns approved Bengaluru provider context", () => {
  const source = read("lib/ai-knowledge.ts");

  assert.match(source, /city: "Bengaluru"/);
  assert.match(source, /\.retrieval_approved\s*===\s*true/);
  assert.match(source, /\.content_approved\s*===\s*true/);
  assert.match(source, /vet_onboarding_status !== "onboarded"/);
  assert.match(source, /preferred_locale === locale/);
  assert.match(source, /provider\.locales\.includes\(locale\)/);
  assert.match(source, /PawSpace Bengaluru knowledge base/);
});

test("triage and after-hours helpers default to en-IN and stay non-diagnostic", () => {
  const triage = read("lib/ai-triage.ts");
  const afterHours = read("lib/ai-after-hours.ts");

  assert.match(triage, /locale: Locale = DEFAULT_AI_LOCALE/);
  assert.match(triage, /safe_next_steps/);
  assert.doesNotMatch(triage, /diagnos(?:e|is)/i);

  assert.match(afterHours, /locale: Locale = DEFAULT_AI_LOCALE/);
  assert.match(afterHours, /AI_AFTER_HOURS_ENABLED/);
  assert.match(afterHours, /content_approved/);
  assert.match(afterHours, /vet_onboarding_status/);
});

test("routing validation enforces locale and speech adapters propagate it", () => {
  const route = read("app/api/ai-routing/route.ts");
  const speechRoute = read("app/api/voice-speech/route.ts");
  const adapter = read("lib/voice-provider-adapter.ts");

  assert.match(route, /normalizeLocale\(body\.locale\)/);
  assert.match(route, /supportedLocales/);
  assert.match(route, /LOCALE_INVALID/);

  assert.match(speechRoute, /normalizeLocale\(body\.language\)/);
  assert.match(speechRoute, /VOICE_LANGUAGE_UNSUPPORTED/);
  assert.match(speechRoute, /language: locale/);
  assert.match(speechRoute, /locale/);
  assert.match(adapter, /\{ audioRef: input\.audioRef, locale, language \}/);
});

test("outbound voice provider payloads propagate canonical locale", () => {
  const bleu = buildBleuAiWorkerRequest({
    bookingReference: "BLR-AI-1",
    callDirection: "outbound",
    recipient: {
      phone: "+919999999999",
      locale: "en-IN",
      customerName: "Ananya",
    },
    workerAccessKey: "bleu-key",
    exotelApiKey: "not-used",
  });

  assert.deepEqual(
    {
      language: bleu.language,
      locale: bleu.locale,
    },
    {
      language: "en-IN",
      locale: "en-IN",
    },
  );

  const exotel = buildExotelAiRequest({
    bookingReference: "BLR-AI-2",
    callDirection: "outbound",
    recipient: {
      phone: "+918888888888",
      locale: "en-IN",
    },
    workerAccessKey: "not-used",
    exotelApiKey: "exotel-key",
  });

  assert.deepEqual(
    {
      language: exotel.voiceResponse.language,
      locale: exotel.voiceResponse.locale,
    },
    {
      language: "en-IN",
      locale: "en-IN",
    },
  );
});
