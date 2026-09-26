/*
 * Audit finding (Dog Training follow-up 4): the mobile Training flow marked Basic Obedience "BEST MATCH" and showed
 * "PAWSPACE RECOMMENDS Basic Obedience Plan" whatever goals the customer picked (staging shot
 * docs/qa-evidence/training-staging-36224833520/shots/020-app-stage2.jpg). The recommendation now comes from the
 * goals, through recommendTrainingPlan in lib/training-goals.ts, on the mobile flow and on V2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PUPPY_PLAN_MAX_AGE_MONTHS, recommendTrainingPlan, TRAINING_CORE_PACKAGE_CODE, TRAINING_FALLBACK_GOALS, TRAINING_GOAL_PACKAGE,
} from "../lib/training-goals.ts";
import { projectTrainerSession } from "../lib/training-provider-projection.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flow = read("app/mobile-app/training-flow.tsx");
const page = read("app/training/page.tsx");

const STARTER = "training-2-starter", PUPPY = "training-4-puppy", BASIC = "training-8-basic", LEASH = "training-8-leash";
// The whole catalogue, in the order listTrainingPackages serves it.
const CATALOGUE = ["trainer-meet-greet", STARTER, PUPPY, BASIC, LEASH, "training-12-leash", "training-12-advanced", "training-16-pro"];
// Level steps goals cannot reveal, and the Meet & Greet: never recommended.
const NEVER_RECOMMENDED = ["trainer-meet-greet", "training-12-leash", "training-12-advanced", "training-16-pro"];
// The fixed tie order the design sets: the core programme, then the smallest plan.
const TIE_ORDER = [BASIC, STARTER, PUPPY, LEASH];
const PUPPY_GOALS = ["Toilet routine", "Biting & chewing", "Socialisation"];

// Midday UTC, so the local calendar date is 26 Sep 2026 in almost every time zone. Birth dates are built from the
// same local date, as the lib counts months from it.
const NOW = Date.UTC(2026, 8, 26, 12, 0);
const bornMonthsAgo = (months, dayShift = 0) => {
  const at = new Date(NOW), date = new Date(at.getFullYear(), at.getMonth() - months, at.getDate() + dayShift);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const recommend = (goals, { packageCodes = CATALOGUE, dogs } = {}) => recommendTrainingPlan({ goals, packageCodes, dogs, now: NOW });
const planFor = (goals, options) => recommend(goals, options)?.packageCode;

// ---------------------------------------------------------------------------------------------------------------
// Drift: the same goal labels live in four places. Each must still point at a plan, and each goal that can win
// BEST MATCH must be one the trainer is shown.
// ---------------------------------------------------------------------------------------------------------------
const seededGoals = JSON.parse(/const defaults=(\[[^\]]*\]);/.exec(read("app/api/training-requirements/route.ts"))[1]);

test("every seeded and fallback goal points at a plan", () => {
  assert.equal(seededGoals.length, 8, "the governed requirements route still seeds eight goals");
  assert.deepEqual([...TRAINING_FALLBACK_GOALS], seededGoals, "the fallback list is the seeded list");
  for (const goal of seededGoals) {
    assert.deepEqual(recommend([goal]), { packageCode: TRAINING_GOAL_PACKAGE.get(goal.toLowerCase()), basis: "goals", matchedGoals: [goal], puppyPlanAgeExcluded: false }, goal);
  }
  for (const key of TRAINING_GOAL_PACKAGE.keys()) assert.equal(key, key.trim().toLowerCase(), `${key} is keyed on the trimmed, lower-cased label`);
  assert.deepEqual(new Set(TRAINING_GOAL_PACKAGE.values()), new Set([STARTER, PUPPY, BASIC, LEASH]), "goals point only at entry programmes");
});

test("the mobile flow offers the shared fallback goals and its default goals still lead to the core plan", () => {
  assert.match(flow, /\[goals, setGoals\] = useState<string\[\]>\(\[\.\.\.TRAINING_FALLBACK_GOALS\]\)/);
  assert.doesNotMatch(flow, /const fallbackGoals/, "no private copy of the goal list");
  const defaults = [.../\[selectedGoals, setSelectedGoals\] = useState\(\[([^\]]*)\]\)/.exec(flow)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(defaults, ["Basic obedience", "Leash walking"]);
  // e2e/training-master-staging.spec.ts, e2e/uat-phase3-partner-training.spec.ts and the V2 acceptance script continue
  // with these goals and book the pre-selected plan.
  assert.deepEqual(recommend(defaults), { packageCode: BASIC, basis: "goals", matchedGoals: ["Basic obedience"], puppyPlanAgeExcluded: false });
});

test("every goal that can win BEST MATCH reaches the trainer's Goals snapshot", () => {
  // projectTrainerSession feeds app/trainer/page.tsx and drops any requirement that is not a known goal.
  const mapped = [...TRAINING_GOAL_PACKAGE.keys()];
  const shown = projectTrainerSession({ requirements: mapped }).requirements.map((goal) => goal.toLowerCase());
  assert.deepEqual([...shown].sort(), [...mapped].sort());
  assert.deepEqual(projectTrainerSession({ requirements: seededGoals }).requirements, seededGoals);
});

// ---------------------------------------------------------------------------------------------------------------
// Mapping, majority and ties
// ---------------------------------------------------------------------------------------------------------------
test("each goal points at the plan whose catalogue copy covers it", () => {
  const expected = {
    "Toilet routine": PUPPY, "Biting & chewing": PUPPY, "Socialisation": PUPPY,
    "Basic obedience": BASIC, "Recall": BASIC, "Recall practice": BASIC,
    "Leash walking": LEASH,
    "Excess barking": STARTER, "Separation anxiety": STARTER,
  };
  for (const [goal, packageCode] of Object.entries(expected)) {
    assert.deepEqual(recommend([goal]), { packageCode, basis: "goals", matchedGoals: [goal], puppyPlanAgeExcluded: false }, goal);
  }
});

test("audit regression: the goals decide the plan, not a fixed Basic Obedience flag", () => {
  assert.equal(planFor(["Leash walking"]), LEASH);
  assert.notEqual(planFor(["Leash walking"]), BASIC);
  assert.equal(new Set(TRAINING_FALLBACK_GOALS.map((goal) => planFor([goal]))).size, 4, "the eight goals lead to four different plans");
});

test("the plan with the most selected goals wins, and ties follow the fixed order", () => {
  assert.deepEqual(recommend(["Toilet routine", "Biting & chewing", "Leash walking"]), { packageCode: PUPPY, basis: "goals", matchedGoals: ["Toilet routine", "Biting & chewing"], puppyPlanAgeExcluded: false });
  assert.deepEqual(recommend(["Basic obedience", "Leash walking", "Recall"]).matchedGoals, ["Basic obedience", "Recall"], "the master E2E journey's goals");
  assert.equal(planFor(["Basic obedience", "Leash walking", "Recall"]), BASIC);
  assert.equal(planFor(["Basic obedience", "Leash walking"]), BASIC, "a tie the core programme is part of goes to it");
  assert.equal(planFor(["Toilet routine", "Basic obedience"]), BASIC);
  assert.equal(planFor(["Socialisation", "Leash walking"]), PUPPY, "otherwise the smaller plan wins");
  assert.equal(planFor(["Separation anxiety", "Leash walking"]), STARTER);
  assert.equal(planFor(["Excess barking", "Toilet routine"]), STARTER);
});

test("neither the order of the goals nor the order of the catalogue changes the plan", () => {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const shuffled = (list) => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
  const goalSets = [
    ["Basic obedience", "Leash walking"], ["Socialisation", "Leash walking"], ["Separation anxiety", "Leash walking"],
    ["Excess barking", "Toilet routine"], ["Toilet routine", "Basic obedience"], ["Recall", "Leash walking", "Toilet routine"],
    ["Excess barking", "Toilet routine", "Recall", "Leash walking"], [...TRAINING_FALLBACK_GOALS], [],
  ];
  for (const goals of goalSets) {
    for (const dogs of [undefined, [{ ageYears: 3 }]]) {
      const expected = recommend(goals, { dogs });
      assert.equal(planFor([...goals].reverse(), { dogs }), expected.packageCode, `reversed ${goals.join(" + ")}`);
      for (let round = 0; round < 12; round++) assert.deepEqual(recommend(goals, { dogs, packageCodes: shuffled(CATALOGUE) }), expected, `shuffled catalogue, ${goals.join(" + ")}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Age: the Puppy plan is for "Puppies up to 8 months". A birth date decides; without one only an age of a year or
// more excludes, because the saved age is a snapshot and the bands are coarse.
// ---------------------------------------------------------------------------------------------------------------
test("an adult dog's puppy goals point to the Starter Plan", () => {
  assert.equal(PUPPY_PLAN_MAX_AGE_MONTHS, 8);
  assert.deepEqual(recommend(["Toilet routine"], { dogs: [{ ageYears: 3 }] }), { packageCode: STARTER, basis: "goals", matchedGoals: ["Toilet routine"], puppyPlanAgeExcluded: true });
  assert.deepEqual(recommend(["Toilet routine", "Biting & chewing"], { dogs: [{ ageYears: 3 }] }).matchedGoals, ["Toilet routine", "Biting & chewing"]);
  assert.equal(planFor(["Toilet routine"], { dogs: [{ ageYears: 1 }] }), STARTER, "the \"1 year\" band");
  assert.equal(planFor(["Toilet routine"], { dogs: [{ ageYears: 0.25 }, { ageYears: 4 }] }), STARTER, "any selected dog past the Puppy plan");
});

test("young, banded and unknown ages keep the Puppy plan", () => {
  for (const dogs of [[{ ageYears: 0.75 }], [{ ageYears: 0.25 }], [{ ageYears: null, profile: null }], [{}], [], undefined]) {
    assert.deepEqual(recommend(["Toilet routine"], { dogs }), { packageCode: PUPPY, basis: "goals", matchedGoals: ["Toilet routine"], puppyPlanAgeExcluded: false }, JSON.stringify(dogs));
  }
});

test("a birth date decides over the saved age, counting full calendar months", () => {
  const born = (dateOfBirth, ageYears) => [{ ageYears, profile: { dateOfBirth } }];
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(7)) }), PUPPY);
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(10), 0.25) }), STARTER, "a stale 0.25 does not hide a 10-month-old");
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(7), 3) }), PUPPY, "nor does a wrong saved age exclude a 7-month-old");
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(8)) }), PUPPY, "8 full months is still up to 8 months");
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(9, 1)) }), PUPPY, "a day short of 9 months");
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(9)) }), STARTER, "9 full months");
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(0, -7)) }), PUPPY, "a week-old puppy");
  // A birth date that proves nothing leaves the saved age to decide.
  assert.equal(planFor(["Toilet routine"], { dogs: born("2026-02-30", 3) }), STARTER);
  assert.equal(planFor(["Toilet routine"], { dogs: born("26/09/2025") }), PUPPY);
  assert.equal(planFor(["Toilet routine"], { dogs: born(bornMonthsAgo(-2), 0.25) }), PUPPY, "a birth date in the future");
});

test("the age guard only touches puppy goals", () => {
  assert.deepEqual(recommend(["Leash walking"], { dogs: [{ ageYears: 3 }] }), { packageCode: LEASH, basis: "goals", matchedGoals: ["Leash walking"], puppyPlanAgeExcluded: false });
  assert.deepEqual(recommend(["Toilet routine", "Basic obedience", "Recall"], { dogs: [{ ageYears: 3 }] }), { packageCode: BASIC, basis: "goals", matchedGoals: ["Basic obedience", "Recall"], puppyPlanAgeExcluded: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Fallback, normalisation and missing plans
// ---------------------------------------------------------------------------------------------------------------
test("with no recognised goal the core programme is the catalogue default", () => {
  // A custom goal, a blank one, and a goal staff renamed: none of them points at a plan.
  for (const goals of [[], ["Jumping on guests"], ["  "], ["Loose-leash walking"]]) {
    assert.deepEqual(recommend(goals), { packageCode: BASIC, basis: "catalogue_default", matchedGoals: [], puppyPlanAgeExcluded: false }, JSON.stringify(goals));
  }
  assert.equal(TRAINING_CORE_PACKAGE_CODE, BASIC);
});

test("a plan missing from the catalogue never scores, and with the core missing too there is no recommendation", () => {
  const without = (...codes) => CATALOGUE.filter((code) => !codes.includes(code));
  assert.deepEqual(recommend(["Leash walking"], { packageCodes: without(LEASH) }), { packageCode: BASIC, basis: "catalogue_default", matchedGoals: [], puppyPlanAgeExcluded: false });
  assert.equal(planFor(["Leash walking", "Toilet routine", "Biting & chewing"], { packageCodes: without(PUPPY) }), LEASH);
  assert.equal(planFor(["Leash walking"], { packageCodes: without(BASIC) }), LEASH, "a goal match does not need the core programme");
  assert.equal(recommend(["Jumping on guests"], { packageCodes: without(BASIC) }), null);
  assert.equal(recommend(["Leash walking"], { packageCodes: without(BASIC, LEASH) }), null);
  assert.equal(recommend(["Basic obedience"], { packageCodes: [] }), null);
  assert.equal(recommend([], { packageCodes: [] }), null);
});

test("goals are trimmed and matched case-insensitively, and a goal counts once", () => {
  assert.deepEqual(recommend(["  leash WALKING "]), { packageCode: LEASH, basis: "goals", matchedGoals: ["leash WALKING"], puppyPlanAgeExcluded: false });
  // Counted twice, Leash walking would beat Basic obedience 2-1.
  assert.deepEqual(recommend(["Leash walking", "leash walking ", "Basic obedience"]), { packageCode: BASIC, basis: "goals", matchedGoals: ["Basic obedience"], puppyPlanAgeExcluded: false });
  assert.equal(planFor([null, 42, "Recall"]), BASIC, "anything that is not a label is ignored");
});

// ---------------------------------------------------------------------------------------------------------------
// Exhaustive: every combination of the eight goals, four kinds of dog and every catalogue the four entry programmes
// can be missing from. The single-goal plan (checked above) is the oracle for what each goal counts towards.
// ---------------------------------------------------------------------------------------------------------------
test("every goal combination recommends the plan most of its goals point at, and only a plan in the catalogue", () => {
  // [dogs, past the Puppy plan]
  const dogKinds = [[undefined, false], [[{ ageYears: 0.25 }], false], [[{ ageYears: 3 }], true], [[{ profile: { dateOfBirth: bornMonthsAgo(10) } }], true]];
  const catalogues = [];
  for (let mask = 0; mask < 16; mask++) catalogues.push([...NEVER_RECOMMENDED, ...TIE_ORDER.filter((_, index) => mask & (1 << index))]);
  let checked = 0;
  for (let subset = 0; subset < 256; subset++) {
    const goals = TRAINING_FALLBACK_GOALS.filter((_, index) => subset & (1 << index));
    for (const [dogs, pastPuppy] of dogKinds) {
      const pointsAt = new Map(goals.map((goal) => [goal, planFor([goal], { dogs })]));
      const puppyPlanAgeExcluded = pastPuppy && goals.some((goal) => PUPPY_GOALS.includes(goal));
      for (const packageCodes of catalogues) {
        const result = recommend(goals, { dogs, packageCodes });
        const counts = TIE_ORDER.map((code) => goals.filter((goal) => pointsAt.get(goal) === code && packageCodes.includes(code)).length);
        const most = Math.max(...counts), label = `${goals.join(" + ") || "no goals"} · ${JSON.stringify(dogs)} · ${packageCodes.join(",")}`;
        if (most === 0) {
          assert.deepEqual(result, packageCodes.includes(BASIC) ? { packageCode: BASIC, basis: "catalogue_default", matchedGoals: [], puppyPlanAgeExcluded } : null, label);
        } else {
          const winner = TIE_ORDER[counts.indexOf(most)];
          assert.deepEqual(result, { packageCode: winner, basis: "goals", matchedGoals: goals.filter((goal) => pointsAt.get(goal) === winner), puppyPlanAgeExcluded }, label);
        }
        if (result) {
          assert.ok(packageCodes.includes(result.packageCode), `${label}: recommended a plan that is not in the catalogue`);
          assert.ok(!NEVER_RECOMMENDED.includes(result.packageCode), `${label}: recommended ${result.packageCode}`);
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 256 * 4 * 16);
});

// ---------------------------------------------------------------------------------------------------------------
// Source contracts: the UI has no DOM test harness here (no jsdom), so its wiring is pinned as text.
// ---------------------------------------------------------------------------------------------------------------
test("mobile: the recommendation comes from the goals, not a fixed flag or heading", () => {
  assert.match(flow, /import \{[^}]*\brecommendTrainingPlan\b[^}]*\} from "\.\.\/\.\.\/lib\/training-goals";/);
  assert.match(flow, /const recommendation = recommendTrainingPlan\(\{ goals: selectedGoals, packageCodes: plans\.map\(\(item\) => item\.packageCode\), dogs: selectedPetObjs \}\);/);
  for (const stale of ["<h4>Basic Obedience Plan</h4>", "recommended:true", "item.recommended", "selectedGoals.slice(0, 2)"]) {
    assert.equal(flow.includes(stale), false, `${stale} is gone`);
  }
  assert.match(flow, /next\.find\(item=>item\.packageCode===TRAINING_CORE_PACKAGE_CODE\)/, "the first selection still falls back to the core programme");
});

test("mobile: opening the options pre-selects only a goal match, and every stage-1 way in goes through the helper", () => {
  const start = flow.indexOf("showTrainingOptions = () => {");
  assert.ok(start > 0, "showTrainingOptions exists");
  const helper = flow.slice(start, flow.indexOf("\n    },", start));
  assert.match(helper, /recommendation\?\.basis === "goals" && recommendedPlan && recommendedPlan\.packageCode !== appliedRecommendation/);
  assert.ok(helper.indexOf("setPlan(recommendedPlan)") > 0 && helper.indexOf("setPlan(recommendedPlan)") < helper.indexOf("setStage(2)"), "the plan is set before stage 2 opens");
  assert.match(helper, /setAppliedRecommendation\(recommendedPlan\.packageCode\)/);
  const stageOne = flow.slice(flow.indexOf("{stage === 1 && ("), flow.indexOf("{stage === 2 && ("));
  assert.match(stageOne, /onClick=\{showTrainingOptions\}>\{selectedPets\.length === 0 \? "Select a dog to continue" : "See training options"\}/);
  assert.equal(stageOne.includes("setStage(2)"), false, "no stage-1 control opens stage 2 around the helper");
});

test("mobile: the banner and badge name the recommended plan and make no claim about the trainer", () => {
  const bannerStart = flow.indexOf("{recommendation && recommendedPlan && <article className={styles.planRecommendation}>");
  assert.ok(bannerStart > 0, "the banner renders only for a recommendation");
  const banner = flow.slice(bannerStart, flow.indexOf("</article>}", bannerStart));
  assert.match(banner, /<span>PAWSPACE RECOMMENDS<\/span><h4>\{recommendedPlan\.name\}<\/h4>/);
  assert.match(banner, /`Best match for \$\{recommendation\.matchedGoals\.join\(" \+ "\)\}: \$\{recommendedPlan\.detail\}/);
  assert.match(banner, /" The Puppy Training Plan is for puppies up to 8 months\."/);
  assert.match(banner, /`Our core programme for \$\{recommendedPlan\.idealFor/);
  assert.doesNotMatch(banner, /trainer|first session|confirm|change/i, "requirements do not all reach the trainer, and the plan is bought before session 1");
  assert.match(flow, /\{item\.packageCode === recommendation\?\.packageCode \? \(recommendation\.basis === "goals" \? "BEST MATCH" : "RECOMMENDED"\) : item\.bonus \? "GROOMING BONUS" : item\.level\.toUpperCase\(\)\}/);
  assert.match(flow, /\{recommendation\?\.basis === "goals" && item\.packageCode === recommendation\.packageCode && <p><b>Matches your goals:<\/b> \{recommendation\.matchedGoals\.join\(", "\)\}<\/p>\}/);
  assert.match(flow, /Final goals are confirmed during the first trainer session\./, "the existing goals note is unchanged");
});

test("V2: a goal match is labelled on its package button and never selected for the customer", () => {
  assert.match(page, /import\{[^}]*\brecommendTrainingPlan\b[^}]*\}from"\.\.\/\.\.\/lib\/training-goals";/);
  assert.match(page, /const recommendation=useMemo\(\(\)=>recommendTrainingPlan\(\{goals,packageCodes:packages\.map\(item=>item\.package_code\),dogs:selectedPets\}\),\[goals,packages,selectedPets\]\);/);
  // Right after the name, so each button's accessible name still starts with the plan name.
  assert.match(page, /<strong>\{item\.name\}<\/strong>\{recommendation\?\.basis==="goals"&&recommendation\.packageCode===item\.package_code&&<small className=\{styles\.block\}>Best match for \{recommendation\.matchedGoals\.join\(" \+ "\)\}<\/small>\}/);
  assert.match(page, /const\[packageCode,setPackageCode\]=useState\("training-4-puppy"\)/, "the default plan is unchanged");
  assert.equal([...page.matchAll(/setPackageCode\(/g)].length, 1, "only the customer's own tap selects a package");
  assert.match(page, /onClick=\{\(\)=>setPackageCode\(item\.package_code\)\}/);
});
