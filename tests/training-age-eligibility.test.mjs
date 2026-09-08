import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {makeCountingD1} from "./helpers/d1-harness.mjs";
installWorkersHooks("__AGE_ELIGIBILITY_DB__");
const {trainingAgeGroup,trainingEligibilityProblem}=await import("../lib/training-age-eligibility.ts");
const {assertTrainingPetEligibility}=await import("../lib/training-pet-eligibility.ts");
const dog=(dob)=>({species:"dog",profile:{dateOfBirth:dob}});
test("six calendar months, including month-end and leap birthdays",()=>{
  assert.equal(trainingAgeGroup(dog("2026-03-09"),"2026-09-08"),"puppy");
  assert.equal(trainingAgeGroup(dog("2026-03-09"),"2026-09-09"),"adult");
  assert.equal(trainingAgeGroup(dog("2025-08-31"),"2026-02-27"),"puppy");
  assert.equal(trainingAgeGroup(dog("2025-08-31"),"2026-02-28"),"adult");
  assert.equal(trainingAgeGroup(dog("2024-02-29"),"2024-08-29"),"adult");
});
test("invalid or future DOB cannot fall back to a stale adult age",()=>{
  for(const dob of ["2026-02-30","tomorrow","2027-01-01"])
    assert.equal(trainingAgeGroup({...dog(dob),ageYears:2},"2026-09-09"),"unknown");
  assert.equal(trainingAgeGroup({species:"dog",ageYears:0.5}),"adult");
  assert.equal(trainingAgeGroup({species:"dog",profile:{ageBand:"< 6 months"}}),"puppy");
});
test("mixed ages and missing ages can assess, but cannot buy an unsuitable programme",()=>{
  const puppy=dog("2026-08-01"),adult=dog("2020-01-01"),today="2026-09-09";
  assert.equal(trainingEligibilityProblem("training-4-puppy",[puppy],today),null);
  assert.ok(trainingEligibilityProblem("training-8-basic",[puppy],today));
  assert.ok(trainingEligibilityProblem("training-4-puppy",[puppy,adult],today));
  assert.equal(trainingEligibilityProblem("training-2-starter",[puppy,adult],today),null);
  assert.ok(trainingEligibilityProblem("training-8-basic",[{species:"dog"}],today));
  assert.ok(trainingEligibilityProblem("trainer-meet-greet",[{species:"cat"}],today));
  assert.ok(trainingEligibilityProblem("invented",[adult],today));
});
test("saved profiles enforce ownership, source aliases and distinct resolved pets",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  try{
    sqlite.exec("CREATE TABLE canonical_pets(id TEXT,customer_id TEXT,source_pet_id TEXT,species TEXT,age_years REAL,profile_json TEXT)");
    const insert=sqlite.prepare("INSERT INTO canonical_pets VALUES(?,?,?,?,?,?)");
    insert.run("P1","C1","source1","dog",2,JSON.stringify({dateOfBirth:"2026-08-01"}));
    insert.run("P2","C2","source2","dog",2,null);
    const {db}=makeCountingD1(sqlite);
    const check=(petIds,packageCode="training-4-puppy")=>assertTrainingPetEligibility(db,{customerId:"C1",petIds,packageCode},"2026-09-09");
    await check(["P1"]);
    await check(["source1"]);
    for(const ids of [["P2"],["missing"],["P1","source1"]])
      await assert.rejects(()=>check(ids),error=>error instanceof Response&&error.status===409);
    await assert.rejects(()=>check(["P1"],"training-8-basic"),error=>error.status===409);
    await assert.rejects(()=>check(["P1","P1"]),error=>error.status===400);
  }finally{sqlite.close();}
});
