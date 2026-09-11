import test from "node:test";
import assert from "node:assert/strict";
import {resolveVerticalRuntime,PHASE2_VERTICALS} from "../lib/agents/runtime/vertical-runtime.ts";

test("Phase 2 vertical registry contains all five operating heads",()=>assert.deepEqual(PHASE2_VERTICALS,["sales","marketing","ops","hr","finance"]));
test("all verticals fail closed when Atlas executive is off",()=>{for(const agent of PHASE2_VERTICALS)assert.equal(resolveVerticalRuntime({},agent).mode,"disabled");});
test("finance execution remains approval-gated without financial mutation switch",()=>{const env={PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_FINANCE_ACTIVE:"true"};assert.equal(resolveVerticalRuntime(env,"finance","execute_within_envelope").mode,"approval_required");});
test("ops provider mutation remains approval-gated without provider switch",()=>{const env={PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_OPS_ACTIVE:"true"};assert.equal(resolveVerticalRuntime(env,"ops","execute_within_envelope").mode,"approval_required");});
