/**
 * An invented discount never reaches a customer: when the grounded provider reports that a reply names a
 * code, percentage or amount off the server did not approve, the orchestrator hands the conversation to
 * a person - even when approved knowledge would otherwise ground the reply.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";

const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
const rollout = await import("../lib/ai-audience-rollout.ts");
const account = await import("../lib/customer-account.ts");

const serviceActor = { email: "meta-whatsapp-ai@system.pawspace", name: "Meta WhatsApp AI service", roleCode: "service_meta_whatsapp_ai", permissions: ["communications.manage"], developmentPreview: false, identitySource: "workspace", principalType: "identity_subject", principalKey: "service:meta-whatsapp-ai" };

async function turn(ctx, key, providerResult) {
  const now = Date.now(), customerId = `CUS-OFFER-${key}`, threadId = `THREAD-OFFER-${key}`, messageId = `MSG-OFFER-${key}`;
  ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{}',?,?)").run(customerId, "blr", "Asha", `98765${String(now).slice(-5)}`, "customer_app", now, now);
  ctx.sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").run(threadId, customerId, now, now);
  ctx.sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,provider,channel,direction,purpose,template_key,payload_json,status,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,'pawspace_web','chat','inbound','transactional','web_app_chat',?,'received',?,'customer',?,?)").run(messageId, threadId, customerId, JSON.stringify({ text: "Grooming is a bit expensive for me, what does Essential Bath cost?" }), `offer-inbound-${key}`, now, now);
  const provider = { status: "connected", provider: "scripted-offer-proof", modelRef: "proof-model", async generate() { return { provider: "scripted-offer-proof", modelRef: "proof-model", latencyMs: 1, referencedCustomerIds: [customerId], groundingRefs: [], highImpactAction: false, confidence: 0.9, ...providerResult }; } };
  return orchestrator.orchestrateAiTurn(ctx.db, { actor: serviceActor, threadId, customerId, inputMessageId: messageId, idempotencyKey: `offer-turn-${key}`, channel: "chat", provider });
}

test("an approved closing offer reaches the customer; an invented one goes to a person", async (t) => {
  const ctx = await setupJourney(); t.after(() => ctx.close());
  await account.ensureCustomerAccountTables(ctx.db);
  await rollout.setAiRolloutStage(ctx.db, { stage: "customers", reason: "approved offers proof", actorEmail: "founder@pawspace.test" });
  await orchestrator.ensureAiConversationOrchestrator(ctx.db);
  const approved = await turn(ctx, "OK", { text: "With code GROOM200, Essential Bath comes to ₹1,149 instead of ₹1,349. Shall I help you book it?", catalogueVerifiedPrices: true, offerClaimsVerified: true });
  assert.equal(approved.turn.outcome, "draft_review_required", JSON.stringify(approved.turn).slice(0, 600));
  assert.match(approved.turn.output, /GROOM200/);
  const invented = await turn(ctx, "BAD", { text: "Use code SAVE50 and get 50% off grooming today!", catalogueVerifiedPrices: true, offerClaimsVerified: false });
  assert.equal(invented.turn.outcome, "handoff");
  assert.equal(invented.turn.handoffReason, "policy_risk");
  assert.doesNotMatch(invented.turn.output, /SAVE50/);
});
