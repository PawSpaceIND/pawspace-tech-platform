import test from "node:test";
import assert from "node:assert/strict";
import { decideExecutiveAction } from "../lib/executive/decision-policy.ts";

test("90 percent capacity wins over sales deficit and hard-throttles",()=>{
 const d=decideExecutiveAction({capacityUtilization:.90,pacingLagFraction:.50,approvedDiscountBps:2000,approvedUpgradeCodes:["UP1"]});
 assert.equal(d.mode,"throttle"); assert.equal(d.pressureMultiplier,0); assert.equal(d.discountBps,0); assert.deepEqual(d.upgradeCodes,[]); assert.equal(d.marginValidationRequired,true);
});

test("lag above 25 percent boosts only the approved commercial envelope",()=>{
 const d=decideExecutiveAction({capacityUtilization:.55,pacingLagFraction:.251,approvedDiscountBps:1200,approvedUpgradeCodes:["BATH_UPGRADE"]});
 assert.equal(d.mode,"boost"); assert.equal(d.pressureMultiplier,1.35); assert.equal(d.discountBps,1200); assert.deepEqual(d.upgradeCodes,["BATH_UPGRADE"]); assert.equal(d.marginValidationRequired,true);
});

test("healthy capacity and pacing keep normal pressure with no autonomous incentive",()=>{
 const d=decideExecutiveAction({capacityUtilization:.4,pacingLagFraction:.25,approvedDiscountBps:2500,approvedUpgradeCodes:["X"]});
 assert.equal(d.mode,"normal"); assert.equal(d.pressureMultiplier,1); assert.equal(d.discountBps,0); assert.deepEqual(d.upgradeCodes,[]);
});
