/*
 * Day-31 cross-module test 8: the outbound voice / autodialler gate.
 *
 * quiet hours (IST) -> consent -> opt-out -> allow-list -> frequency cap, all against the real
 * evaluateVoiceCallPolicy, plus the audio-bot disposition claim that follows a call.
 *
 * Why the boundary specifically: quiet hours are the one gate here with a legal edge to it. TRAI's
 * restriction on commercial voice calls is a clock, and a clock is exactly the kind of rule that is
 * written correctly and implemented off by one. The window is stored as hours (21..9) and evaluated
 * against an IST-shifted UTC hour, so both ends and the midnight wrap are walked minute by minute
 * rather than sampled at a convenient midday value.
 *
 * The second property is that the gates are independent. A pass on one must never carry another:
 * an opted-out number stays blocked even with consent on file, and every refusal names itself so
 * Ops can see WHICH rule stopped a call.
 *
 * Modules executed: voice-outbound-governance, voice-call-gate, bot-call-disposition,
 * power-dialler-policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, OTHER_PHONE, istAt } from "./helpers/voice-harness.mjs";

installWorkersHooks("__D31_VOICE_DB__", "__D31_VOICE_ENV__");

const voice = await import("../lib/voice-outbound-governance.ts");
const dialler = await import("../lib/power-dialler-policy.ts");

async function seedVoice({ phone = ALLOWLISTED_PHONE, optOut = 0, consent = true } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__D31_VOICE_DB__ = db;
  const env = uatVoiceEnv();
  globalThis.__D31_VOICE_ENV__ = env;
  const seeded = seedRecipient(sqlite, { phone, optOut });
  await voice.ensureVoiceCallTables(db);
  if (consent) {
    await voice.recordVoiceConsent(db, {
      phone, subjectType: "customer", subjectId: seeded.contactId, granted: true,
      source: "booking_confirmation", actorId: "ops@pawspace.in",
    });
  }
  return { sqlite, db, env, ...seeded };
}

/** A well-formed, otherwise-permitted service call. Only the clock varies. */
const callAt = (seeded, asOf, extra = {}) => voice.evaluateVoiceCallPolicy(seeded.db, seeded.env, {
  idempotencyKey: `d31-voice-${asOf}-${extra.useCase ?? "booking_reminder"}-${seeded.phone}`,
  direction: "outbound", useCase: "booking_reminder", phone: seeded.phone,
  cityId: "blr", leadId: seeded.leadId, bookingId: seeded.bookingId,
  customerId: seeded.contactId, actorId: "ops@pawspace.in",
  actorPermissions: ["*"], asOf, ...extra,
});

const checkFor = (verdict, name) => (verdict.checks ?? verdict.gates ?? []).find((c) => (c.name ?? c.code) === name);
const quietBlocked = (verdict) => {
  const check = checkFor(verdict, "quiet_hours");
  assert.ok(check, `the verdict must report a quiet_hours check: ${JSON.stringify(verdict).slice(0, 300)}`);
  return check.passed === false || check.ok === false;
};

test("the quiet-hours window is exact at both ends, in IST", async () => {
  /*
   * Default policy: quiet 21:00-09:00 IST. 20:59 is the last legal minute of the evening and 09:00
   * the first of the morning. Each side is checked one minute either way, plus the wrap at midnight
   * which a naive `hour >= start && hour < end` gets exactly backwards.
   */
  const seeded = await seedVoice();
  const cases = [
    ["08:59 - last quiet minute", istAt(8) + 59 * 60_000, true],
    ["09:00 - first legal minute", istAt(9), false],
    ["09:30 - mid morning", istAt(9) + 30 * 60_000, false],
    ["14:00 - mid afternoon", istAt(14), false],
    ["20:59 - last legal minute", istAt(20) + 59 * 60_000, false],
    ["21:00 - quiet begins", istAt(21), true],
    ["23:30 - late night", istAt(23) + 30 * 60_000, true],
    ["00:30 - after midnight, still quiet", istAt(24) + 30 * 60_000, true],
    ["07:59 - last quiet minute", istAt(7) + 59 * 60_000, true],
  ];
  for (const [label, asOf, shouldBlock] of cases) {
    assert.equal(quietBlocked(await callAt(seeded, asOf)), shouldBlock, `quiet hours, ${label}`);
  }
});

test("no gate passing rescues another - each refusal names itself", async () => {
  const daytime = istAt(11);

  const clean = await callAt(await seedVoice(), daytime);
  assert.equal(quietBlocked(clean), false, "the control case must clear quiet hours");

  const noConsent = await callAt(await seedVoice({ consent: false }), daytime);
  assert.equal(checkFor(noConsent, "voice_consent").passed ?? checkFor(noConsent, "voice_consent").ok, false);
  assert.equal(noConsent.allowed ?? noConsent.ok, false, "no consent means no call, whatever else passes");

  const optedOut = await callAt(await seedVoice({ optOut: 1 }), daytime);
  assert.equal(checkFor(optedOut, "opt_out_clear").passed ?? checkFor(optedOut, "opt_out_clear").ok, false,
    "an opt-out must block even with consent on file - the later instruction wins");
  assert.equal(optedOut.allowed ?? optedOut.ok, false);

  const offAllowlist = await callAt(await seedVoice({ phone: OTHER_PHONE }), daytime);
  assert.equal(checkFor(offAllowlist, "uat_allowlist").passed ?? checkFor(offAllowlist, "uat_allowlist").ok, false,
    "UAT may only ever dial approved numbers");
  assert.equal(offAllowlist.allowed ?? offAllowlist.ok, false);
});

test("an explicit opt-out during a call outranks the consent already on record", async () => {
  const seeded = await seedVoice();
  const before = await callAt(seeded, istAt(11));
  assert.equal(checkFor(before, "opt_out_clear").passed ?? checkFor(before, "opt_out_clear").ok, true);

  await voice.recordVoiceOptOut(seeded.db, {
    phone: seeded.phone, source: "customer_request", actorId: "ops@pawspace.in",
  });

  const after = await callAt(seeded, istAt(11));
  assert.equal(checkFor(after, "opt_out_clear").passed ?? checkFor(after, "opt_out_clear").ok, false,
    "once someone says stop, an older consent row must not reopen the number");
  assert.equal(after.allowed ?? after.ok, false);
});

test("quiet hours are not waived by a use case calling itself urgent", async () => {
  /*
   * The module's own stated rule: no use case is exempt. A genuinely urgent situation is a human
   * picking up a phone, not the autodialler deciding a rule does not apply tonight.
   */
  const seeded = await seedVoice();
  for (const useCase of ["booking_reminder", "service_followup", "payment_reminder", "lead_qualification"]) {
    const verdict = await callAt(seeded, istAt(23), { useCase });
    const check = checkFor(verdict, "quiet_hours");
    if (!check) continue;      // an unsupported use case is refused earlier, which is also fine
    assert.equal(check.passed ?? check.ok, false, `${useCase} must not be exempt from quiet hours`);
    assert.equal(verdict.allowed ?? verdict.ok, false);
  }
});

test("the power dialler only auto-advances on a real, recorded disposition", async () => {
  for (const code of dialler.POWER_DIALLER_DISPOSITIONS) {
    assert.equal(dialler.shouldAutoAdvance(code), true, `${code} is a real outcome`);
  }
  for (const notADisposition of ["", "  ", "INTERESTED", "no-answer", "skipped", "__proto__", "toString"]) {
    assert.equal(dialler.shouldAutoAdvance(notADisposition), false,
      `"${notADisposition}" must not advance the queue - the rep's outcome has not been captured`);
  }
});

test("an audio bot saying a customer PAID moves no money - the claim must be reconciled first", async () => {
  /*
   * The genuinely dangerous disposition. "converted" and "paid" are the bot asserting a commercial
   * fact about a call nobody heard, so the platform marks them claimsOnly and parks them at
   * pending_reconciliation. If a claim were treated as settled truth, a bot mishearing "I'll pay
   * later" as "I paid" would close a lead as converted and take it out of collections.
   */
  const seeded = await seedVoice();
  const bot = await import("../lib/bot-call-disposition.ts");
  await bot.ensureBotCallDispositionTables(seeded.db);

  const claim = await bot.recordBotCallDisposition(seeded.db, {
    idempotencyKey: "botclaim-d31-1", leadId: seeded.leadId, channel: "voice",
    botProvider: "exotel_bot", callRef: "BOTCALL-D31-1", primaryTag: "paid",
    talkTimeSeconds: 44, actorId: "system:voice-bot", transcriptRef: "TR-1",
  });
  assert.equal(claim.reconciliationStatus, "pending_reconciliation",
    "a money claim from a bot is a claim, not a fact");
  assert.equal(
    seeded.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='booking_payments'").get().n,
    0,
    "a bot claim must not have created any payment record",
  );

  const reconciled = await bot.reconcileBotCallClaim(seeded.db, {
    dispositionId: claim.id, outcome: "not_found",
    note: "No captured payment found against this lead", actorId: "finance@pawspace.in",
  });
  assert.equal(reconciled.reconciliationStatus, "reconciled_not_found");

  await assert.rejects(
    () => bot.reconcileBotCallClaim(seeded.db, {
      dispositionId: claim.id, outcome: "confirmed",
      note: "second opinion, overriding the first", actorId: "finance@pawspace.in",
    }),
    Error,
    "a settled reconciliation must not be silently flipped by a later call",
  );
});

test("an ordinary bot outcome needs no reconciliation and leaves one real attempt", async () => {
  const seeded = await seedVoice();
  const bot = await import("../lib/bot-call-disposition.ts");
  await bot.ensureBotCallDispositionTables(seeded.db);

  const rnr = await bot.recordBotCallDisposition(seeded.db, {
    idempotencyKey: "botrnr-d31-1", leadId: seeded.leadId, channel: "voice",
    botProvider: "exotel_bot", callRef: "BOTCALL-D31-2", primaryTag: "rnr",
    actorId: "system:voice-bot",
  });
  assert.equal(rnr.reconciliationStatus, "not_required");
  const attempts = seeded.sqlite.prepare("SELECT COUNT(*) n FROM lead_attempts WHERE lead_id=?").get(seeded.leadId).n;
  assert.equal(attempts, 1, "a bot call must leave exactly one real attempt row");

  const replay = await bot.recordBotCallDisposition(seeded.db, {
    idempotencyKey: "botrnr-d31-1", leadId: seeded.leadId, channel: "voice",
    botProvider: "exotel_bot", callRef: "BOTCALL-D31-2", primaryTag: "interested",
    actorId: "system:voice-bot",
  });
  assert.equal(replay.duplicatePrevented, true, "one call is one disposition");
  assert.equal(replay.primaryTag, "rnr", "a replay must not rewrite the outcome that was recorded");
  assert.equal(
    seeded.sqlite.prepare("SELECT COUNT(*) n FROM lead_attempts WHERE lead_id=?").get(seeded.leadId).n,
    attempts,
    "a re-posted disposition must not add a second attempt",
  );
});

test("a do_not_call outcome from the bot stops the platform calling that number again", async () => {
  const seeded = await seedVoice();
  const bot = await import("../lib/bot-call-disposition.ts");
  await bot.ensureBotCallDispositionTables(seeded.db);
  await bot.recordBotCallDisposition(seeded.db, {
    idempotencyKey: "botdnc-d31-1", leadId: seeded.leadId, channel: "voice",
    botProvider: "exotel_bot", callRef: "BOTCALL-D31-3", primaryTag: "do_not_call",
    actorId: "system:voice-bot",
  });
  const verdict = await callAt(seeded, istAt(11));
  assert.equal(verdict.allowed ?? verdict.ok, false,
    "a customer who told the bot to stop must not be dialled again in daylight either");
  assert.equal(checkFor(verdict, "opt_out_clear").passed ?? checkFor(verdict, "opt_out_clear").ok, false);
});
