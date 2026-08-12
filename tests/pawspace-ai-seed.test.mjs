import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const seed = await read("../lib/pawspace-ai-seed.ts");
const route = await read("../app/api/ai-bootstrap/route.ts");

test("AI grounding seed: governed lifecycle, real PawSpace knowledge, price-free", () => {
  assert.match(seed, /export async function seedPawspaceAiAssistant/);
  // governed lifecycle: draft -> submit_review -> approve -> activate (checker distinct from maker)
  assert.match(seed, /action: "submit_review", actorEmail: maker/);
  assert.match(seed, /action: "approve", actorEmail: checker/);
  assert.match(seed, /action: "activate", actorEmail: checker/);
  // grounded in the real modules built this session
  for (const k of ["pawspace_wallet", "paw_points_loyalty", "pet_passport", "vaccination_reminders", "cancellation_refund", "emergency_help", "reviews_rewards"]) {
    assert.match(seed, new RegExp(`sourceKey: "${k}"`), `knowledge base covers ${k}`);
  }
  assert.match(seed, /10% enhanced value/);
  // deliberately price-free: quote live, never from memory
  assert.match(seed, /quote a price/i);
  assert.match(seed, /Never quote a price, discount or availability from memory/);
  // guardrails baked into the system prompt
  assert.match(seed, /cannot issue refunds, capture payments, change prices, assign providers or start campaigns/);
  assert.match(seed, /hand off complaints, refund\/payment disputes, safety and any pet medical emergency/i);
  // multilingual + pinned model
  assert.match(seed, /supportedLanguages: \["en", "hi", "ta"\]/);
  assert.match(seed, /modelRef: "claude-sonnet-4-6"/);
  // Control route is staff-gated
  assert.match(route, /requirePermission\(actor,"settings\.manage"\)/);
});
