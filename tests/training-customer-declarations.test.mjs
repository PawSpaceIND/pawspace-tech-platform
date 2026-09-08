import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {trainingEligibilityProblem} from "../lib/training-age-eligibility.ts";
const source=readFileSync(new URL("../app/mobile-app/training-flow.tsx",import.meta.url),"utf8");
test("training does not invent health, behaviour or agreement declarations",()=>{
  assert.ok(source.includes('[healthSafetyNotes, setHealthSafetyNotes] = useState("")'));
  assert.ok(source.includes('[behaviourNotes, setBehaviourNotes] = useState("")'));
  assert.ok(source.includes('[agreed, setAgreed] = useState(false)'));
  assert.ok(source.includes('disabled={!healthSafetyNotes || !selectedGoals.length'));
  assert.ok(source.includes('if(!agreed || !healthSafetyNotes)'));
});
test("training package copy follows requested puppy age and catalogue deposit",()=>{
  assert.ok(source.includes("Puppies under 6 months"));
  assert.ok(!source.includes("up to 8 months"));
  assert.ok(source.includes("Pay {plan.splitDuePercent}% upfront"));
  assert.equal(trainingEligibilityProblem("training-4-puppy",[{species:"dog",ageYears:0.4}]),null);
  assert.ok(trainingEligibilityProblem("training-4-puppy",[{species:"dog",ageYears:0.5}]),"the executable rule must agree with the under-six-month copy");
});
