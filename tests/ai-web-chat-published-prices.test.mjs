/**
 * Owner decision 8: guests asking a price got "I don't have a verified PawSpace answer" although prices are
 * published. Without a model connected, a price question about one service is answered with the lowest active
 * single-pet price as "from Rs X", never a final amount; paused packages are never quoted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__AI_PRICE_DB__", "__AI_PRICE_ENV__");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const { runPublicAiWebChat } = await import("../lib/ai-web-chat-adapter.ts");

async function world(activeCodes) {
  const sqlite = new DatabaseSync(":memory:"), db = d1(sqlite);
  await ensurePricingControlRuntime(db);
  for (const code of activeCodes) sqlite.prepare("UPDATE service_packages SET active=1 WHERE package_code=?").run(code);
  return db;
}
const ask = async (db, query) => (await runPublicAiWebChat(db, { query, sessionKey: "price-test" })).ai.turn.output;

test("a grooming price question is answered from the lowest active published price", async () => {
  const db = await world(["dog-basic", "dog-makeover", "dog-basic__2_pets"]);
  const answer = await ask(db, "What is the price of grooming?");
  assert.match(answer, /Grooming starts from ₹1,899 for one pet/);
  assert.match(answer, /confirmed at checkout/);
});

test("paused packages are never quoted", async () => {
  const db = await world(["dog-makeover"]);
  assert.match(await ask(db, "how much does grooming cost"), /from ₹2,399/);
});

test("a question that is not about price keeps the service answer", async () => {
  const db = await world(["dog-basic"]);
  assert.doesNotMatch(await ask(db, "Do you offer grooming?"), /₹/);
});
