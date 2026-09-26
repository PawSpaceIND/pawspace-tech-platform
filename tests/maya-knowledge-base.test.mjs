/**
 * PawSpace AI's service knowledge (Maya's WATI knowledge base plus PawSpace additions) is approved
 * knowledge the AI retrieves by the customer's own words: every entry fits what retrieval returns, none
 * states a rupee amount (prices come only from the live catalogue), and re-seeding publishes only changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb } from "./helpers/ai-harness.mjs";

installAiHooks();
const kb = await import("../lib/maya-knowledge-base.ts");
const config = await import("../lib/ai-business-configuration.ts");

test("every entry is retrievable whole, uniquely keyed and free of prices", () => {
  const keys = new Set();
  for (const entry of kb.MAYA_KNOWLEDGE) {
    assert.ok(!keys.has(entry.sourceKey), entry.sourceKey); keys.add(entry.sourceKey);
    assert.ok(entry.contentText.length <= 1600, `${entry.sourceKey} is cut by retrieval`);
    assert.doesNotMatch(entry.contentText, /₹|\bRs\.?\s?\d|\bINR\b|\d{3},\d{3}|\b\d{3,5}\s?(rupees|\/-)/i, `${entry.sourceKey} quotes an amount`);
    assert.doesNotMatch(entry.contentText, /\bGROOM\d{3}\b/, `${entry.sourceKey} names a coupon code outside the approved-offers list`);
  }
  assert.ok(kb.MAYA_KNOWLEDGE.length >= 40);
});

test("customer questions find the right knowledge", async () => {
  const { db } = freshAiDb();
  const seeded = await kb.seedMayaKnowledge(db, { maker: "maker@pawspace.in", checker: "checker@pawspace.in" });
  assert.deepEqual(seeded, { activated: kb.MAYA_KNOWLEDGE.length, unchanged: 0, total: kb.MAYA_KNOWLEDGE.length });
  const top = async (query) => (await config.retrieveApprovedKnowledge(db, { query, visibilityScopes: ["public"] })).results[0]?.sourceKey;
  assert.equal(await top("should I shave my husky double coat"), "maya_grooming_coat_advice");
  assert.equal(await top("what vaccination is needed for boarding packing checklist"), "maya_boarding_requirements");
  assert.equal(await top("difference between boarding and sitting and daycare"), "maya_boarding_vs_sitting");
  assert.equal(await top("I want to talk to a human agent, call me"), "maya_human_request");
  assert.equal(await top("money debited but payment failed"), "maya_payment_problems");
  assert.equal(await top("cat routine grooming without bath"), "maya_grooming_cats");
  assert.equal(await top("pet funeral cremation"), "maya_funeral");
  assert.equal(await top("relocation to another city abroad microchip"), "maya_relocation");
});

test("re-seeding publishes only the entries that changed", async () => {
  const { db } = freshAiDb();
  await kb.seedMayaKnowledge(db, { maker: "maker@pawspace.in", checker: "checker@pawspace.in" });
  const edited = kb.MAYA_KNOWLEDGE.map((entry) => entry.sourceKey === "maya_walking" ? { ...entry, contentText: `${entry.contentText} Updated.` } : entry);
  assert.deepEqual(await kb.seedMayaKnowledge(db, { maker: "maker@pawspace.in", checker: "checker@pawspace.in", entries: edited }), { activated: 1, unchanged: kb.MAYA_KNOWLEDGE.length - 1, total: kb.MAYA_KNOWLEDGE.length });
});
