import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks();
const { resolveCapacityConflict } = await import("../lib/agents/atlas-ceo-supervisor.ts");
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), "utf8");

test("Atlas capacity conflict becomes a proposal-only halt and pivot recommendation", () => {
  assert.equal(resolveCapacityConflict({utilization:0.91,cityId:"blr",zoneId:"z1",serviceCode:"grooming"}).length,2);
  assert.equal(resolveCapacityConflict({utilization:0.90,cityId:"blr",zoneId:"z1",serviceCode:"grooming"}).length,0);
  const atlas = read("lib/agents/atlas-ceo-supervisor.ts");
  assert.match(atlas, /input\.utilization <= 0\.90/);
  assert.match(atlas, /action: "halt_outbound_promotion"/);
  assert.match(atlas, /alternatives: \["dog_training", "boarding"\]/);
  assert.match(atlas, /target_pacing_lag_above_25_percent/);
  assert.match(atlas, /recordAtlasProposal/);
  assert.match(atlas, /proposalOnly:true/);
  assert.match(atlas, /workerRouterCalled:false/);
  assert.match(atlas, /directives:\[\]/);
  assert.doesNotMatch(atlas, /await route\(/);
});

test("human escalation router contains all four hard-stop classes", () => {
  const router = read("lib/executive/human-escalation-router.ts");
  for (const kind of ["safety_injury", "financial_batch_threshold", "prolonged_gateway_outage", "provider_capacity_exhausted"]) assert.match(router, new RegExp(kind));
  assert.match(router, /executionHalted: true/);
});

test("agents preserve canonical execution boundaries", () => {
  const ops = read("lib/agents/ops-manager-agent.ts"), marketing = read("lib/agents/marketing-manager-agent.ts"), atlas = read("lib/agents/atlas-ceo-supervisor.ts");
  assert.match(ops, /providerRecover/);
  assert.match(ops, /canonicalMutationTool: "provider\.recover"/);
  assert.match(ops, /enqueueCommunication/);
  assert.doesNotMatch(ops, /UPDATE canonical_bookings/);
  assert.match(marketing, /enqueueCommunication/);
  assert.match(marketing, /outbound_routing_queue/);
  assert.doesNotMatch(marketing, /UPDATE canonical_bookings/);
  assert.match(atlas, /lineLevelExecution:false/);
  assert.match(atlas, /canonicalExecutionOnly:true/);
  assert.match(atlas, /riskClass:"medium"/);
});
