import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import "tsx/esm";
const { evaluateVetTriage, ensureVetHealthcareTables, calculateVetPayout, VET_SAC_CODE, VET_TAX_PAISE, VET_VISIT_FEE_PAISE } = await import("../lib/vet-healthcare.ts");

test("Vet emergency red flags bypass booking and routine cases retain ₹599/0% GST", () => {
  const emergency=evaluateVetTriage({symptoms:"My dog is having a seizure and is not breathing"});
  assert.equal(emergency.level,"emergency");assert.equal(emergency.bookable,false);assert.equal(emergency.requiresHumanEscalation,true);assert.equal(emergency.medicationAdvice,null);
  const routine=evaluateVetTriage({symptoms:"Ticks and mild itching for two days"});
  assert.equal(routine.bookable,true);assert.equal(routine.feePaise,VET_VISIT_FEE_PAISE);assert.equal(routine.taxPaise,VET_TAX_PAISE);assert.equal(routine.sacCode,VET_SAC_CODE);
});

test("Vet schema physically rejects non-zero tax", async()=>{
  const {sqlite,db}=freshCountingD1();await ensureVetHealthcareTables(db);
  assert.throws(()=>sqlite.prepare("INSERT INTO vet_appointments (id,customer_id,pet_id,triage_level,triage_summary,tax_paise,created_at,updated_at) VALUES ('A','C','P','routine','ticks',1,1,1)").run(),/CHECK constraint failed/);
});

test("full-time Vet records salaried KPI with zero payout and commission Vet uses governed split",async()=>{
  const {sqlite,db}=freshCountingD1();await ensureVetHealthcareTables(db);const now=Date.now();
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,status,effective_from,updated_by,updated_at,contract_type,vci_registration_number,vci_verification_status) VALUES ('V1','blr','Vet One','full_time','[\"vet_consult\"]','[\"blr-east\"]','active','2026-01-01','test',?,'full_time','VCI-1','verified')").run(now);
  sqlite.prepare("INSERT INTO vet_appointments (id,customer_id,pet_id,provider_id,triage_level,triage_summary,status,created_at,updated_at) VALUES ('A1','C','P','V1','routine','ticks','completed',?,?)").run(now,now);
  const salaried=await calculateVetPayout(db,{appointmentId:'A1',providerId:'V1',actorId:'ops'});assert.equal(salaried.providerPayoutPaise,0);assert.equal(salaried.taxPaise,0);assert.equal(salaried.visitKpi,1);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,status,effective_from,updated_by,updated_at,contract_type,vci_registration_number,vci_verification_status) VALUES ('V2','blr','Vet Two','commission','[\"vet_consult\"]','[\"blr-east\"]','active','2026-01-01','test',?,'commission','VCI-2','verified')").run(now);
  sqlite.prepare("INSERT INTO vet_appointments (id,customer_id,pet_id,provider_id,triage_level,triage_summary,status,created_at,updated_at) VALUES ('A2','C','P','V2','routine','vaccination','completed',?,?)").run(now,now);
  sqlite.prepare("INSERT INTO vet_provider_payout_terms (id,provider_id,provider_share_bps,status,effective_from,created_by,created_at,updated_at) VALUES ('T2','V2',6000,'active','2026-01-01','ops',?,?)").run(now,now);
  const commission=await calculateVetPayout(db,{appointmentId:'A2',providerId:'V2',actorId:'ops'});assert.equal(commission.providerPayoutPaise,35940);assert.equal(commission.platformRetainedPaise,23960);assert.equal(commission.taxPaise,0);
});
