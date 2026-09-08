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
test("optional meeting details retain booking wiring and readable touch controls",()=>{
  const css=readFileSync(new URL("../app/mobile-app/training-meeting.module.css",import.meta.url),"utf8");
  assert.ok(source.includes('<details className={meetStyles.meeting}>'));
  assert.ok(source.includes('onClick={confirmMeetFirst}'));
  assert.ok(source.includes('aria-pressed={meetSlot===slot}'));
  assert.ok(css.includes("min-height:52px"));
  assert.ok(css.includes("font-size:1rem"));
  assert.ok(css.includes("var(--paw-primary"));
  assert.ok(!source.includes("standalone canonical Meet &amp; Greet"));
});
