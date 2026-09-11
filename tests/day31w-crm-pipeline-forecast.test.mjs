/*
 * Day-31 wave 6: the CRM probabilistic pipeline forecast.
 *
 * open opportunities + closed history -> per-stage win probability -> weighted / commit / best case.
 *
 * lib/crm-pipeline-forecast.ts had no test importing it. This is the number a founder plans
 * hiring and spend against, and its whole claim is that the probabilities are LEARNED from real
 * closed deals rather than asserted - so the thing worth attacking is the learning itself. A
 * forecast that is merely wrong is bad; one that is confidently wrong because its own history
 * query double-counts is worse, because nothing about the output looks unusual.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_FC_DB__", "__D31W_FC_ENV__");

const ACTOR = "founder@pawspace.in";
const PRIOR_NEGOTIATION = 0.70;   // the published default before any history exists

async function seedForecast() {
  const { sqlite, db } = world("__D31W_FC_DB__", "__D31W_FC_ENV__");
  const forecast = await import("../lib/crm-pipeline-forecast.ts");
  await forecast.ensureCrmPipelineTables(db);
  return { sqlite, db, forecast };
}

let seq = 0;
const addOpportunity = (sqlite, { stage, status = "open", amount = 10000 }) => {
  const id = `OPP-${++seq}`;
  const now = Date.now();
  sqlite.prepare("INSERT INTO crm_opportunities (id,lead_id,customer_id,service_code,owner,stage,status,amount,stage_probability,next_best_action,source,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,'call','lead',?,?,?)")
    .run(id, `LEAD-${id}`, `CUS-${id}`, "grooming", "rep@pawspace.in", stage, status, amount, ACTOR, now, now);
  return id;
};

/** Record that an opportunity passed THROUGH a stage - the row the probability learns from. */
const passedThrough = (sqlite, opportunityId, stage, times = 1) => {
  for (let i = 0; i < times; i++) {
    sqlite.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`HIST-${opportunityId}-${stage}-${i}`, opportunityId, "proposal", stage, 0.5, 10000, "Day-31 stage move", ACTOR, Date.now() + i);
  }
};

const stageOf = (result, stage) => (result.stages ?? result.stageAnalytics ?? {})[stage];

test("with no closed history at all, a stage sits at its published prior", async () => {
  const { sqlite, db, forecast } = await seedForecast();
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });
  const result = await forecast.buildProbabilisticForecast(db, { actorId: ACTOR });
  const negotiation = stageOf(result, "negotiation");
  assert.ok(negotiation, `negotiation must appear: ${JSON.stringify(Object.keys(result))}`);
  assert.equal(Math.round(negotiation.probability * 10000) / 10000, PRIOR_NEGOTIATION,
    "with nothing learned, the prior is the honest answer");
  assert.equal(result.weightedPipeline, 70000);
  assert.equal(result.unweightedPipeline, 100000);
});

test("one early win does not swing a stage to certainty", async () => {
  /*
   * The shrinkage the module documents. A single closed deal must move the number a little, not
   * declare the stage a sure thing - otherwise the first win of a quarter rewrites the plan.
   */
  const { sqlite, db, forecast } = await seedForecast();
  const won = addOpportunity(sqlite, { stage: "won", status: "won" });
  passedThrough(sqlite, won, "negotiation");
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });

  const probability = stageOf(await forecast.buildProbabilisticForecast(db, { actorId: ACTOR }), "negotiation").probability;
  assert.ok(probability > PRIOR_NEGOTIATION, "a real win must move the number");
  assert.ok(probability < 0.75, `one win must not swing negotiation to certainty (got ${probability})`);
});

test("a deal that revisits a stage is ONE sample, not several", async () => {
  /*
   * THE CASE THAT MATTERS. Deals go backwards: negotiation -> proposal -> negotiation is an
   * ordinary week in sales, and each pass writes another stage-history row.
   *
   * The learning query counted samples with COUNT(DISTINCT opportunity_id) but summed wins across
   * the raw joined rows, so one opportunity that entered negotiation three times and then won
   * contributed 1 sample and 3 wins. More wins than samples is not a probability, and it silently
   * inflates the forecast the business plans against.
   */
  const { sqlite, db, forecast } = await seedForecast();
  const revisited = addOpportunity(sqlite, { stage: "won", status: "won" });
  passedThrough(sqlite, revisited, "negotiation", 3);
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });

  const threePasses = stageOf(await forecast.buildProbabilisticForecast(db, { actorId: ACTOR }), "negotiation").probability;

  const fresh = await seedForecast();
  const once = addOpportunity(fresh.sqlite, { stage: "won", status: "won" });
  passedThrough(fresh.sqlite, once, "negotiation", 1);
  addOpportunity(fresh.sqlite, { stage: "negotiation", amount: 100000 });
  const singlePass = stageOf(await fresh.forecast.buildProbabilisticForecast(fresh.db, { actorId: ACTOR }), "negotiation").probability;

  assert.equal(
    Math.round(threePasses * 10000) / 10000, Math.round(singlePass * 10000) / 10000,
    `one won deal is one won deal however many times it passed through the stage (3 passes gave ${threePasses}, 1 pass gave ${singlePass})`,
  );
});

test("a lost deal that revisits a stage is also counted once", async () => {
  const { sqlite, db, forecast } = await seedForecast();
  const lost = addOpportunity(sqlite, { stage: "lost", status: "lost" });
  passedThrough(sqlite, lost, "negotiation", 4);
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });

  const probability = stageOf(await forecast.buildProbabilisticForecast(db, { actorId: ACTOR }), "negotiation").probability;
  assert.ok(probability < PRIOR_NEGOTIATION, "a loss must pull the number down");
  assert.ok(probability > 0.6, `one loss must not collapse the stage either (got ${probability})`);
});

test("a probability is always a probability", async () => {
  const { sqlite, db, forecast } = await seedForecast();
  for (let i = 0; i < 12; i++) {
    const won = addOpportunity(sqlite, { stage: "won", status: "won" });
    passedThrough(sqlite, won, "negotiation", 1 + (i % 4));
  }
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });
  const result = await forecast.buildProbabilisticForecast(db, { actorId: ACTOR });
  for (const [stage, bucket] of Object.entries(result.stages ?? result.stageAnalytics ?? {})) {
    assert.ok(bucket.probability >= 0 && bucket.probability <= 1,
      `${stage} probability must be within [0,1], got ${bucket.probability}`);
  }
  assert.ok(result.weightedPipeline <= result.unweightedPipeline + 0.01,
    "a weighted forecast can never exceed the raw pipeline it weights");
});

test("commit and best case are subsets of the pipeline, in the right order", async () => {
  const { sqlite, db, forecast } = await seedForecast();
  addOpportunity(sqlite, { stage: "new", amount: 100000 });
  addOpportunity(sqlite, { stage: "proposal", amount: 100000 });
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });
  addOpportunity(sqlite, { stage: "committed", amount: 100000 });

  const r = await forecast.buildProbabilisticForecast(db, { actorId: ACTOR });
  assert.equal(r.unweightedPipeline, 400000);
  assert.ok(r.commitForecast <= r.weightedPipeline + 0.01, "commit is the weighted value of the latest stages only");
  assert.equal(r.bestCaseForecast, 200000, "best case is the unweighted value of negotiation and beyond");
  assert.ok(r.bestCaseForecast <= r.unweightedPipeline);
});

test("closed opportunities are not forecast as though they were still open", async () => {
  const { sqlite, db, forecast } = await seedForecast();
  addOpportunity(sqlite, { stage: "negotiation", amount: 100000 });
  addOpportunity(sqlite, { stage: "won", status: "won", amount: 500000 });
  addOpportunity(sqlite, { stage: "lost", status: "lost", amount: 500000 });
  const r = await forecast.buildProbabilisticForecast(db, { actorId: ACTOR });
  assert.equal(r.unweightedPipeline, 100000, "a won or lost deal is not pipeline");
});

test("an empty pipeline forecasts zero rather than failing", async () => {
  const { db, forecast } = await seedForecast();
  const r = await forecast.buildProbabilisticForecast(db, { actorId: ACTOR });
  assert.equal(r.weightedPipeline, 0);
  assert.equal(r.unweightedPipeline, 0);
  assert.equal(r.bestCaseForecast, 0);
});
