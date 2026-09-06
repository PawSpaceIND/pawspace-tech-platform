import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv, ALLOWLISTED_PHONE, DAYTIME } from "./helpers/voice-harness.mjs";

installWorkersHooks("__SRAB_DB__", "__SRAB_ENV__");
const bot = await import("../lib/service-recovery-audio-bot.ts");
const voice = await import("../lib/voice-outbound-governance.ts");
const cases = await import("../lib/unified-case-center.ts");

const fakeAi = {
  async run(model, input) {
    if (String(model).includes("melotts")) return { audio: Buffer.from("phase3-audio").toString("base64") };
    return { text: "I understand", confidence: 0.98 };
  },
};

async function fresh({ speech = true } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  const env = { ...uatVoiceEnv(), ...(speech ? { AI: fakeAi } : {}) };
  globalThis.__SRAB_DB__ = db;
  globalThis.__SRAB_ENV__ = env;
  await bot.ensureServiceRecoveryAudioBotTables(db);
  // createUnifiedCase() ensures these itself in production, so they only exist once an escalation
  // has actually happened. Create them up front so the "no human case was manufactured" assertion
  // reads zero rows rather than throwing on a missing table and proving nothing.
  await cases.ensureUnifiedCaseTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (
      id TEXT PRIMARY KEY, primary_phone TEXT, consent_json TEXT
    );
    CREATE TABLE IF NOT EXISTS canonical_bookings (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL, service_code TEXT, status TEXT
    );
    INSERT INTO canonical_customers (id,primary_phone,consent_json)
      VALUES ('CON-R1','${ALLOWLISTED_PHONE}','{"serviceUpdates":true}');
    INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,status)
      VALUES ('BKG-R1','CON-R1','blr','dog_walking','assigned');
  `);
  await voice.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-R1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  return { sqlite, db, env };
}

async function addRecoveryMessage(db, { id, templateKey, payload = {}, purpose = "service_recovery" }) {
  const now = DAYTIME;
  await db.prepare("INSERT OR IGNORE INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-R1','CON-R1','BKG-R1',NULL,NULL,'open','ops',NULL,?,?)").bind(now,now).run();
  await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,'THREAD-R1','CON-R1','BKG-R1',NULL,NULL,'outbound','whatsapp',?,?,?,'queued',NULL,NULL,?,'{}','test',?,?)")
    .bind(id,purpose,templateKey,JSON.stringify(payload),`idem-${id}`,now,now).run();
}

const jobs = sqlite => sqlite.prepare("SELECT * FROM service_recovery_voice_jobs ORDER BY created_at,id").all();
const calls = sqlite => sqlite.prepare("SELECT * FROM voice_call_orders ORDER BY requested_at,id").all();
const attempts = sqlite => sqlite.prepare("SELECT * FROM service_recovery_voice_attempts ORDER BY attempt_no").all();

test("only operational service recovery templates are eligible; money recovery is excluded", async () => {
  const { sqlite, db } = await fresh();
  await addRecoveryMessage(db,{id:"MSG-LATE",templateKey:"provider_running_late",payload:{reason:"traffic delay"}});
  await addRecoveryMessage(db,{id:"MSG-NO",templateKey:"provider_no_show_warning"});
  await addRecoveryMessage(db,{id:"MSG-REFUND",templateKey:"refund_delayed_recovery"});
  await addRecoveryMessage(db,{id:"MSG-PAY",templateKey:"payment_recovery_failed"});
  const staged = await bot.stageServiceRecoveryAudioBotJobs(db,{asOf:DAYTIME});
  assert.equal(staged.staged,2,"lateness and no-show are staged");
  assert.equal(staged.skipped,2,"refund/payment recovery is not turned into an audio bot call");
  assert.deepEqual(jobs(sqlite).map(row=>row.trigger_kind).sort(),["provider_lateness","provider_no_show"]);
});

test("speech readiness is a hard pre-dial gate and falls to one human case without ringing", async () => {
  const { sqlite, db, env } = await fresh({speech:false});
  await addRecoveryMessage(db,{id:"MSG-LATE",templateKey:"provider_running_late"});
  const result = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME,env});
  assert.equal(result.dialled,0);
  assert.equal(calls(sqlite).length,0,"telephony is never contacted when no audio bot engine is ready");
  const [job] = jobs(sqlite);
  assert.equal(job.status,"escalated");
  assert.equal(job.attempt_count,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE source_type='service_recovery_voice_job'").get().n,1);
});

test("a governed recovery intent dials once and duplicate scheduler sweeps do not duplicate it", async () => {
  const { sqlite, db, env } = await fresh();
  await addRecoveryMessage(db,{id:"MSG-NO",templateKey:"provider_no_show_warning"});
  const first = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME,env});
  assert.equal(first.dialled,1);
  assert.equal(calls(sqlite).length,1);
  const [call] = calls(sqlite);
  assert.equal(call.use_case,"service_recovery");
  assert.equal(call.consent_decision,"granted");
  assert.equal(call.state,"dialing");
  assert.equal(call.booking_id,"BKG-R1");
  const second = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME+60_000,env});
  assert.equal(second.dialled,0,"an awaiting call is observed rather than redialled");
  assert.equal(calls(sqlite).length,1);
  assert.equal(jobs(sqlite).length,1,"source message idempotency stages one recovery job");
});

test("two no-answer outcomes are the hard loop ceiling; the third action is human escalation", async () => {
  const { sqlite, db, env } = await fresh();
  await addRecoveryMessage(db,{id:"MSG-NO",templateKey:"provider_no_show_warning"});
  await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME,env});
  let call = calls(sqlite)[0];
  await voice.transitionVoiceCall(db,{callId:call.id,to:"no_answer",reason:"simulated no answer",actor:"provider:test",asOf:DAYTIME+30_000});
  await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME+60_000,env});
  let [job] = jobs(sqlite);
  assert.equal(job.status,"retry_pending");
  assert.equal(attempts(sqlite)[0].disposition,"rnr");

  const retryAt = Number(job.next_attempt_at)+1;
  const retried = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:retryAt,env});
  assert.equal(retried.dialled,1);
  assert.equal(calls(sqlite).length,2,"only the second automated attempt is created");
  call = calls(sqlite)[1];
  await voice.transitionVoiceCall(db,{callId:call.id,to:"no_answer",reason:"simulated second no answer",actor:"provider:test",asOf:retryAt+30_000});
  await bot.runServiceRecoveryAudioBotSweep(db,{asOf:retryAt+60_000,env});

  [job] = jobs(sqlite);
  assert.equal(job.status,"escalated");
  assert.equal(job.attempt_count,2);
  assert.equal(calls(sqlite).length,2,"no third automated call exists");
  assert.equal(attempts(sqlite).length,2);
  assert.equal(attempts(sqlite)[1].disposition,"rnr");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE source_type='service_recovery_voice_job'").get().n,1,"one human case, not an escalation loop");
  await bot.runServiceRecoveryAudioBotSweep(db,{asOf:retryAt+20*60_000,env});
  assert.equal(calls(sqlite).length,2,"terminal escalated jobs remain terminal on later scheduler sweeps");
});

test("connected recovery binds the existing AI voice thread and stores only an opening audio digest", async () => {
  const { sqlite, db, env } = await fresh();
  await addRecoveryMessage(db,{id:"MSG-LATE",templateKey:"provider_running_late"});
  await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME,env});
  const call = calls(sqlite)[0];
  await voice.transitionVoiceCall(db,{callId:call.id,to:"connected",reason:"simulated answer",actor:"provider:test",asOf:DAYTIME+10_000});
  const activated = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME+20_000,env});
  assert.equal(activated.audioSessions,1);
  const ai = sqlite.prepare("SELECT * FROM ai_voice_calls").get();
  assert.equal(ai.thread_id,"THREAD-R1");
  assert.equal(ai.customer_id,"CON-R1");
  assert.equal(ai.direction,"outbound");
  assert.equal(ai.consent_status,"verified");
  const attempt = attempts(sqlite)[0];
  assert.equal(attempt.speech_provider,"workers_ai");
  assert.match(attempt.opening_audio_sha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(attempt,"phone"),false,"recovery disposition ledger has no raw phone column");

  await voice.completeVoiceCall(db,{callId:call.id,reason:"recovery information delivered",actorId:"system:service-recovery-audio-bot",asOf:DAYTIME+30_000});
  const closed = await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME+40_000,env});
  assert.equal(closed.completed,1);
  const [job] = jobs(sqlite);
  assert.equal(job.status,"completed");
  assert.equal(job.last_disposition,"info_shared");
  assert.equal(attempts(sqlite)[0].bot_tag,"info_shared");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE source_type='service_recovery_voice_job'").get().n,0,"successful bot recovery never manufactures a human case");
});

test("sabotage checks: removing either outbox scoping or the hard attempt ceiling would make this suite red", async () => {
  const { sqlite, db, env } = await fresh();
  await addRecoveryMessage(db,{id:"MSG-TXN",templateKey:"provider_no_show_warning",purpose:"transactional"});
  await addRecoveryMessage(db,{id:"MSG-MONEY",templateKey:"payment_no_show_recovery",purpose:"service_recovery"});
  const staged = await bot.stageServiceRecoveryAudioBotJobs(db,{asOf:DAYTIME});
  assert.equal(staged.staged,0,"purpose scoping and money exclusions are both active");
  assert.equal(bot.SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS,2,"the automation loop ceiling is a reviewed constant");
  assert.equal(calls(sqlite).length,0);
  assert.equal((await bot.runServiceRecoveryAudioBotSweep(db,{asOf:DAYTIME,env})).dialled,0);
});
