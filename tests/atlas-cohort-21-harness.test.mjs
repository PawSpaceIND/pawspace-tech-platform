/**
 * TEST / LOCAL executable harness for the authoritative frozen 21-case cohort (docs/atlas/frozen-cohort-21.source.json).
 * Source fields are never modified; this file produces a SEPARATE observation per frozen ID. A case is "qualified" only under
 * the cohort's own strict criterion: correct FULL declared terminal outcome with zero staff/provider/Finance/human operational
 * steps. Simulated (TEST) provider/payment/consent stages are manual inputs, so they disqualify a case even when they pass.
 * Cases with no local executor are reported as not_executed with the exact reason; nothing is inferred for them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";
import { executeGroomingNormalJourney, executeGroomingCancelRefundJourney, RUN_DESCRIPTOR } from "./helpers/atlas-grooming-journey-executors.mjs";

const cohort = JSON.parse(readFileSync(new URL("../docs/atlas/frozen-cohort-21.source.json", import.meta.url), "utf8"));
const EXECUTORS = { "OPS-GROOMING-01": executeGroomingNormalJourney, "OPS-GROOMING-02": executeGroomingCancelRefundJourney };
const TERMINAL_STAGE = { "OPS-GROOMING-01": "9.consented_followup", "OPS-GROOMING-02": "11.consented_followup" };
const observations = [];

function classify(job, stages) {
  const terminal = stages.find((s) => s.stage === TERMINAL_STAGE[job.id]);
  const autonomous = stages.filter((s) => s.outcome === "autonomous").map((s) => s.stage);
  const manual = stages.filter((s) => String(s.outcome).startsWith("manual")).map((s) => `${s.stage}: ${s.outcome}`);
  const blocked = stages.filter((s) => String(s.outcome).startsWith("blocked")).map((s) => `${s.stage}: ${s.outcome}`);
  const notExecuted = stages.filter((s) => String(s.outcome).startsWith("not_executed")).map((s) => `${s.stage}: ${s.outcome}`);
  const terminalReached = Boolean(terminal) && (terminal.outcome === "autonomous" || String(terminal.outcome).startsWith("manual"));
  const qualified = terminalReached && manual.length === 0 && blocked.length === 0 && notExecuted.length === 0;
  return { qualified, wholeCase: qualified ? "qualified" : blocked.length ? "blocked" : manual.length ? "manual" : "not_terminal", terminalReached, autonomous, manual, blocked, notExecuted };
}

for (const job of cohort.jobs) {
  test(`[cohort] ${job.id} (${job.service}/${job.branch}) frozen=${job.status}`, async (t) => {
    const executor = EXECUTORS[job.id];
    if (!executor) {
      observations.push({ id: job.id, service: job.service, branch: job.branch, frozenStatus: job.status, frozenObservedAutonomousSuccess: job.observedAutonomousSuccess, observation: "not_executed", reason: `no local executor for ${job.service}/${job.branch}; nothing inferred`, qualified: false, wholeCase: "not_executed", environment: "none" });
      return;
    }
    const ctx = await setupJourney(); t.after(ctx.close);
    const started = Date.now();
    let stages = [], error = null;
    try { ({ stages } = await executor(ctx)); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const elapsedMs = Date.now() - started;
    const verdict = error ? { qualified: false, wholeCase: "blocked", terminalReached: false, autonomous: [], manual: [], blocked: [`executor_error: ${error}`], notExecuted: [] } : classify(job, stages);
    observations.push({ id: job.id, service: job.service, branch: job.branch, frozenStatus: job.status, frozenObservedAutonomousSuccess: job.observedAutonomousSuccess, observation: "executed_locally_TEST", environment: "local in-memory SQLite D1, real route handlers, TEST actors; not hosted", runDescriptor: RUN_DESCRIPTOR, elapsedMs, withinTimeout: elapsedMs <= job.timeoutSeconds * 1000, providerSimulationDisclosed: stages.some((s) => /TEST provider|simulated/i.test(`${s.actor} ${s.label ?? ""}`)), mandatoryApprovals: job.mandatoryApprovals, ...verdict, stages });
    assert.equal(error, null, error ?? "");
    assert.equal(verdict.qualified, false, "a TEST-simulated or blocked case must never be counted as a qualified whole journey");
  });
}

test.after(() => {
  assert.equal(cohort.cohortSize, 21); assert.equal(observations.length, 21);
  const qualified = observations.filter((o) => o.qualified).length;
  const summary = { frozenAt: cohort.frozenAt, successCriterion: cohort.successCriterion, denominator: 21, qualifiedWholeJourneys: qualified, executedLocallyTEST: observations.filter((o) => o.observation === "executed_locally_TEST").length, notExecuted: observations.filter((o) => o.observation === "not_executed").length, label: "TEST/LOCAL observations; frozen statuses untouched; 0/21 qualified is not a measured operational failure rate (source ratePolicy)" };
  console.log("COHORT_PACKET " + JSON.stringify({ summary, observations }, null, 1));
});
