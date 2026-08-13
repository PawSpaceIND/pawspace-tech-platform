// Produces the AI demo rows for scripts/uat-demo-seed.sql by RUNNING THE REAL AI ENGINE.
//
// Why not hand-write the INSERTs like the rest of the seed: the AI tables store an engine
// vocabulary, not free text. `outcome` is only ever 'draft_review_required' or 'handoff';
// `policy_decision` is only ever 'draft_review_required' | 'human_handoff' | 'blocked_high_impact';
// `intent_code` is only ever a member of AiConversationIntent; `queue_code` is only ever one of the
// queues lib/ai-human-handoff.ts routes to; and a configuration version's `immutable_hash` is a
// SHA-256 of its own snapshot. Hand-written rows passed the column check but carried values the
// engine can never emit, so /team/ai/analytics grouped by categories that cannot occur in
// production. Executing the real libs against an in-memory SQLite makes that class of drift
// impossible: whatever the engine writes is what the seed contains.
//
// Determinism: crypto.randomUUID and Date.now are replaced with deterministic counters for the
// duration of the run (crypto.subtle stays real, so the configuration hashes are genuine), which is
// what keeps the generated .sql byte-identical between runs.

import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// The libs import each other with extensionless specifiers ("./ai-governance"), which tsc and the
// bundler resolve but Node's native ESM loader does not. Same resolve hook the test suite uses.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

/** Minimal D1 surface over node:sqlite — including meta.changes, which completeAiVoiceCall reads. */
function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => {
      const result = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    exec: async (sql) => { sqlite.exec(sql); },
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
  };
}

const staffActor = (email, name) => ({ email, name, roleCode: "superuser", permissions: ["*"], developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: email });

/**
 * A declared, self-labelling scripted provider. orchestrateAiTurn already accepts a provider as an
 * argument (that is how the test suite drives it), so this uses the real extension point rather than
 * faking rows. Every turn it produces records provider='uat_demo_scripted' in the canonical row, so
 * nothing in the seed can be mistaken for output from a real model.
 */
const scriptedProvider = (replies) => ({
  status: "connected",
  provider: "uat_demo_scripted",
  modelRef: "uat-demo-scripted-v1",
  async generate(input) {
    const text = replies[input.intent.intent] || replies.default;
    return { text, provider: "uat_demo_scripted", modelRef: "uat-demo-scripted-v1", latencyMs: 480, inputTokens: 140 + input.inputText.length, outputTokens: text.length, costMinor: 0, confidence: 0.9 };
  },
});

const REPLIES = {
  booking_status: "Your booking is confirmed and the assigned PawSpace partner is on schedule. I'll message you again when they start heading over.",
  service_info: "PawSpace covers grooming, dog training, boarding, pet sitting, pet taxi, dog walking and fresh food. I can pull the live price for any of those from the catalogue — which one would you like?",
  booking_change: "I can help you move that appointment. Tell me the new day and time you'd prefer and I'll check what the partner has open.",
  subscription_wallet: "I can see your PawSpace Wallet and subscription on your account. Wallet credit carries 10% enhanced value when you spend it on a booking.",
  default: "Let me check that for you.",
};

// The demo conversations. Each line is chosen so the engine lands on a DIFFERENT governed path:
// answered, explicit human request, and a policy-risk block. Nothing here forces an outcome — the
// classifier and the policy rules decide, exactly as they would for a real customer.
const CONVERSATIONS = [
  { thread: "UATD-TH-1", customer: "UATD-CUS-1", booking: "UATD-BK-GROOM-1", channel: "whatsapp", messages: ["Hi, what is the booking status for the grooming appointment?", "Thanks. Can I talk to someone from your team about the next one?"] },
  { thread: "UATD-TH-2", customer: "UATD-CUS-2", booking: "UATD-BK-GROOM-2", channel: "chat", messages: ["What do you offer and what is the price for boarding?"] },
  { thread: "UATD-TH-3", customer: "UATD-CUS-3", booking: "UATD-BK-TRAIN-1", channel: "chat", messages: ["I was charged twice for the training session, I want a refund"] },
  { thread: "UATD-TH-4", customer: "UATD-CUS-4", booking: "UATD-BK-WALK-1", channel: "chat", messages: ["I need to reschedule my booking to the weekend"] },
  { thread: "UATD-TH-5", customer: "UATD-CUS-5", booking: "UATD-BK-BOARD-2", channel: "whatsapp", messages: ["What is my wallet balance and when does my subscription renew?"] },
];

// Dump order matters: parents before children, so the .sql loads cleanly into a cold database.
export const AI_TABLES = [
  "ai_audience_rollout",
  "ai_assistant_profile_versions",
  "ai_prompt_policy_versions",
  "ai_knowledge_source_versions",
  "ai_intent_versions",
  "ai_kill_switches",
  "ai_config_audit_events",
  "ai_evaluation_results",
  "communication_threads",
  "communication_participants",
  "communication_messages",
  "conversation_assignments",
  "conversation_audit_events",
  "ai_conversation_sessions",
  "ai_context_snapshots",
  "ai_suggestions",
  "ai_audit_events",
  "ai_conversation_turns",
  "ai_handoffs",
  "ai_handoff_events",
  "ai_voice_calls",
  "ai_voice_segments",
  "ai_voice_events",
  "ai_explicit_csat",
];

/**
 * Runs the real AI stack over a scratch database and returns the rows it wrote.
 *
 * @param {object} input
 * @param {Map<string,{sql:string,cols:Set<string>}>} input.ddl  DDL captured from the owning sources.
 * @param {Array} input.customers  the demo customers already in the seed.
 * @param {Array} input.bookings   the demo bookings already in the seed.
 * @param {number} input.now       the seed's fixed "today".
 * @param {(offsetDays:number,hour?:number)=>string} input.isoAt
 * @returns {Promise<Array<[string, Record<string, unknown>]>>} [table, row] pairs, in load order.
 */
export async function runRealAiDemo({ ddl, customers, bookings, now, isoAt }) {
  // --- determinism -----------------------------------------------------------
  const realNow = Date.now, realUuid = crypto.randomUUID.bind(crypto);
  let clock = now - 2 * 86_400_000, seq = 0;
  Date.now = () => (clock += 250);
  crypto.randomUUID = () => {
    const n = ++seq;
    return `uatd${String(n).padStart(4, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };

  try {
    const sqlite = new DatabaseSync(":memory:");
    const db = makeD1(sqlite);

    // Canonical context the AI turn reads (Customer 360). DDL comes from the captured map, so these
    // are the same CREATE statements the rest of the seed emits — never retyped here.
    for (const table of ["canonical_customers", "canonical_pets", "canonical_bookings", "customer_experience_tickets"]) {
      const meta = ddl.get(table);
      if (!meta) throw new Error(`AI demo run needs DDL for '${table}' — add its owning file to SOURCES`);
      sqlite.exec(`${meta.sql};`);
    }
    for (const c of customers) {
      sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(c.id, c.city, c.name, c.phone, null, null, "uat_demo_seed", JSON.stringify({ serviceUpdates: true, marketing: true }), now, now);
      sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`${c.id}-PET`, c.id, c.pet, c.species, c.breed, "up_to_date", c.pet.toLowerCase(), now, now);
    }
    for (const b of bookings) {
      sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(b.id, `uatd-${b.id}`, b.cus, JSON.stringify([`${b.cus}-PET`]), "[]", "blr", "blr-east", b.svc, b.svc, b.pkg, `UATD-GRP-${b.id}`, b.provider, isoAt(b.start, 10), isoAt(b.start, 12), b.status, "customer_app", b.amount, "INR", "{}", "uat_demo_seed", now, now);
    }

    // --- the real libs ---------------------------------------------------------
    const seed = await import("../lib/pawspace-ai-seed.ts");
    const config = await import("../lib/ai-business-configuration.ts");
    const rollout = await import("../lib/ai-audience-rollout.ts");
    const governance = await import("../lib/ai-governance.ts");
    const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
    const handoff = await import("../lib/ai-human-handoff.ts");
    const voice = await import("../lib/ai-voice-uat.ts");
    const analytics = await import("../lib/ai-analytics.ts");

    await analytics.ensureAiAnalytics(db); // chains every AI + communication ensure
    await config.ensureAiBusinessConfiguration(db);
    await governance.ensureAiGovernance(db);

    const maker = "uat.demo.manager@tkpetcare.in", checker = "founder@pawspace.in";
    const staff = staffActor(maker, "Demo · Jyoti (Manager)");

    // 1. Business configuration through the real draft -> review -> approve -> activate lifecycle.
    //    This is the same call POST /api/ai-bootstrap makes, so the rows (and their SHA-256
    //    immutable hashes and audit trail) are exactly what the product itself would produce.
    await seed.seedPawspaceAiAssistant(db, { maker, checker });

    // 2. Staff-first rollout: the AI answers the internal team, customers still reach a human.
    //    Deliberately NOT 'customers' — widening that is a human decision on /team/ai/rollout.
    await rollout.setAiRolloutStage(db, { stage: "staff_only", reason: "UAT demo seed: staff-first preview", actorEmail: checker });

    // 3. The safety contract, so /team/ai reports a real suite result instead of zeroes.
    await governance.runAiSafetyContract(db);

    // 4. Conversations. Threads and inbound messages are canonical rows the engine reads; the turns
    //    themselves are produced by orchestrateAiTurn, not written here.
    const provider = scriptedProvider(REPLIES);
    let messageSeq = 0;
    for (const conversation of CONVERSATIONS) {
      const created = Date.now();
      await db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,NULL,NULL,'open','ai-orchestrator',NULL,?,?)")
        .bind(conversation.thread, conversation.customer, conversation.booking, created, created).run();
      await db.prepare("INSERT INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)")
        .bind(`${conversation.thread}-PART`, conversation.thread, "customer", conversation.customer, conversation.customer, created).run();
      for (const text of conversation.messages) {
        const messageId = `UATD-MSG-${String(++messageSeq).padStart(3, "0")}`, at = Date.now();
        await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound',?,'transactional','inbound_freeform',?,'received','pawspace_web',NULL,?,?,?,?,?)")
          .bind(messageId, conversation.thread, conversation.customer, conversation.channel, JSON.stringify({ text }), `uatd-in-${messageId}`, JSON.stringify({ authenticated: true, customerOwned: true, externalDelivery: false }), conversation.customer, at, at).run();
        await orchestrator.orchestrateAiTurn(db, { actor: staff, threadId: conversation.thread, customerId: conversation.customer, inputMessageId: messageId, idempotencyKey: `uatd-turn-${messageId}`, channel: conversation.channel, provider });
      }
    }

    // 5. A staff takeover, so /team/ai/handoff opens on a live, taken-over case rather than "no
    //    handoff is active". Thread 1 is the one the customer explicitly asked for a human on.
    await handoff.manageAiHumanHandoff(db, { actor: staff, threadId: "UATD-TH-1", customerId: "UATD-CUS-1", action: "take_over", reason: "Demo seed: CX picked up the customer's request for a human" });

    // 6. A voice call end to end, through the real voice UAT lib. recordAiVoiceTranscriptSegment
    //    orchestrates its own turn and does NOT accept a provider argument, so the voice turn runs
    //    against the fail-closed default and hands off — which is exactly what a voice call does
    //    today with no provider key configured. Completing it as a live-agent transfer keeps the
    //    call row honest about that, and gives the analytics voice section a real transfer to show.
    const call = await voice.startAiVoiceUatCall(db, { actor: staff, customerId: "UATD-CUS-4", direction: "inbound", transportProvider: "sandbox_simulator", consent: true, language: "en-IN" });
    await voice.recordAiVoiceTranscriptSegment(db, { actor: staff, callId: call.callId, segmentIndex: 1, speaker: "customer", text: "Hi, I wanted the booking status for the dog walking session", sttProvider: "sandbox_simulator", sttConfidence: 0.91 });
    await voice.recordAiVoiceTranscriptSegment(db, { actor: staff, callId: call.callId, segmentIndex: 2, speaker: "assistant", text: "I’m routing this call to a PawSpace team member.", sttProvider: "sandbox_simulator", sttConfidence: null });
    await voice.transferAiVoiceToAgent(db, { actor: staff, callId: call.callId, reason: "voice_ai_provider_not_connected", confidence: 0.87 });

    // 7. Explicit CSAT — submitted ratings only, which is the only thing lib/ai-analytics.ts will
    //    read (it never infers sentiment).
    for (const [index, csat] of [["UATD-TH-2", "UATD-CUS-2", 5], ["UATD-TH-4", "UATD-CUS-4", 4]].entries()) {
      await db.prepare("INSERT INTO ai_explicit_csat (id,thread_id,customer_id,rating,source,created_at) VALUES (?,?,?,?,?,?)")
        .bind(`UATD-CSAT-${index + 1}`, csat[0], csat[1], csat[2], "post_chat_survey", Date.now()).run();
    }

    // --- dump ------------------------------------------------------------------
    const out = [];
    for (const table of AI_TABLES) {
      const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) throw new Error(`AI demo run expected table '${table}' to exist after the real ensure chain`);
      for (const row of sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        const clean = {};
        for (const [key, value] of Object.entries(row)) clean[key] = typeof value === "bigint" ? Number(value) : value;
        out.push([table, clean]);
      }
    }
    return out;
  } finally {
    Date.now = realNow;
    crypto.randomUUID = realUuid;
  }
}
