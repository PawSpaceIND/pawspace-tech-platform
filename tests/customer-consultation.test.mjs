import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCustomerConsultation,consultationDiscoveryReply} from '../lib/customer-consultation.ts';
import {evaluateConsultationTurn} from '../lib/customer-consultation-evaluation.ts';
const catalogue={grooming:[{package_code:'BASIC',name:'Hygiene',description:'Bath, hygiene cleanup',base_price:1000,currency:'INR',tax_inclusive:1},{package_code:'FULL',name:'Full grooming',description:'Bath, hygiene cleanup, haircut',base_price:1600,currency:'INR',tax_inclusive:1}],dogTraining:[{package_code:'START',name:'Starter',sessions:4,base_price:4000,currency:'INR',validity_days:30},{package_code:'MORE',name:'Practice',sessions:8,base_price:7200,currency:'INR',validity_days:60}],boarding:[{base_price_per_pet:99}],petSitting:[{base_price_per_pet:99}],petTaxi:[{amount:99}]};
const context={pets:[{id:'OWNED',name:'Bruno',age_months:8}],catalogue};
for(const channel of ['voice','chat'])test(`${channel}: multi-turn needs/constraints survive and comparisons use supplied facts`,()=>{
 const history=[{role:'user',content:'I need grooming, hygiene and haircut.'},{role:'assistant',content:'Would you like bath only?'},{role:'user',content:'Bruno. My budget is tight and weekends are best.'}];
 const plan=buildCustomerConsultation({history,currentText:'Compare the options and recommend a fit.',context,channel});
 assert.equal(plan.service,'grooming');assert.deepEqual(plan.needs,['hygiene','haircut']);assert.equal(plan.phase,'compare');
 assert.match(plan.constraints.budget.text,/budget/);assert.match(plan.constraints.time.text,/weekends/);
 assert.equal(plan.comparisonOptions[1].verifiedDescription,'Bath, hygiene cleanup, haircut');
 assert.equal(plan.comparisonOptions[0].totalBasePrice,1000);assert.equal(plan.comparisonOptions[0].taxInclusive,true);
 assert.equal(plan.bookingConsent,false);assert.equal(plan.identityVerified,false);
 assert.equal(evaluateConsultationTurn({reply:'Full grooming adds the verified haircut you requested; Hygiene includes bath and cleanup. Which option suits your budget?',expectedFacts:['haircut','budget'],informationOnly:true,actions:[]}).passed,true);
});
test('generic puppy skills asks actual challenge and reuses exposed CRM age',()=>{
 const plan=buildCustomerConsultation({history:[{role:'user',content:'I want training for puppy skills.'}],currentText:'What would you recommend?',context,channel:'voice'});
 assert.equal(plan.service,'dog_training');assert.equal(plan.questions.length,1);assert.doesNotMatch(consultationDiscoveryReply(plan,'What would you recommend?'),/How old/);
 assert.equal(evaluateConsultationTurn({reply:consultationDiscoveryReply(plan,'What would you recommend?'),expectedFacts:['improve'],informationOnly:true,actions:[]}).passed,true);
 const unknown=buildCustomerConsultation({history:[],currentText:'Recommend puppy skills training.',context:{catalogue},channel:'chat'});
 assert.equal(unknown.questions.length,2);
 const answered=buildCustomerConsultation({history:[{role:'user',content:'I need training for jumping; Bruno is 8 months old.'}],currentText:'Recommend a suitable plan.',context,channel:'voice'});
 assert.equal(answered.questions.length,0);assert.equal(answered.phase,'compare');assert.equal(answered.comparisonOptions[1].perSessionBasePrice,900);
 assert.equal(answered.comparisonOptions[1].taxInclusive,null,'no inferred inclusive tax flag');
 assert.equal(consultationDiscoveryReply(answered,'Recommend a suitable plan.'),null);
});
test('price and current-plan policy outrank discovery; caregiver and Taxi catalogue amounts are excluded',()=>{
 for(const request of ['Recommend training and tell me the fees.','Recommend training and explain the rates.','Recommend training and tell me the charges.','Recommend training; what will I pay?' ,'How much is training; recommend a plan?','Can I cancel after one training session?','Can I upgrade the selected training plan?']){
  const plan=buildCustomerConsultation({history:[],currentText:request,context,channel:'voice'});assert.equal(consultationDiscoveryReply(plan,request),null);
 }
 for(const service of ['boarding','pet_sitting','pet_taxi']){
  const plan=buildCustomerConsultation({history:[],currentText:'Compare options.',context,service,channel:'chat'});assert.deepEqual(plan.comparisonOptions,[]);
  if(service!=='pet_taxi')assert.equal(plan.nextStep,'verified_caregiver_information_then_app');
 }
 const funeral=buildCustomerConsultation({history:[],currentText:'My pet died; funeral help.',context,channel:'voice'});
 assert.equal(funeral.nextStep,'bereavement_support_then_existing_specialist_path');assert.equal(consultationDiscoveryReply(funeral,'Recommend funeral options.'),null);
});
test('adversarial responses and actions are measured, not prompt presence',()=>{
 for(const [reply,failure] of [['You can usually upgrade later.','unsupported_sales_claim'],['Guaranteed results.','unsupported_sales_claim'],['I connected you to a teammate.','unreceipted_live_handoff'],['First? Second? Third?','too_many_questions']])assert.ok(evaluateConsultationTurn({reply}).failures.includes(failure));
 assert.ok(evaluateConsultationTurn({reply:'Here is your comparison.',informationOnly:true,actions:[{toolCode:'booking.create'}]}).failures.includes('information_only_actions'));
 assert.ok(evaluateConsultationTurn({reply:'Maya needs a bath.',expectedFacts:['Bruno','haircut'],forbiddenFacts:['Maya']}).failures.includes('stale_context:Maya'));
});

test('adversarial negation and pet switches clear stale needs and age',()=>{
 const history=[{role:'user',content:'Bruno needs grooming, hygiene and haircut.'}];
 const noCut=buildCustomerConsultation({history,currentText:'No haircut anymore.',context,channel:'voice'});
 assert.deepEqual(noCut.needs,['hygiene']);
 for(const refusal of ["I don't want a sitter.",'No funeral.','Not walking.','No daycare.']){
  const plan=buildCustomerConsultation({history,currentText:refusal,context,channel:'chat'});assert.equal(plan.service,'grooming',refusal);
 }
 const household={pets:[{id:'BRUNO',name:'Bruno',age_years:1},{id:'COCO',name:'Coco'}],catalogue};
 const changed=buildCustomerConsultation({history:[{role:'user',content:'Training for Bruno, 8 months old, jumping.'}],currentText:'Use Coco instead; recommend training.',context:household,channel:'voice'});
 assert.equal(changed.knownAge,false);assert.ok(changed.questions.includes('How old is your pet?'));
 const newPet=buildCustomerConsultation({history:[],currentText:'Recommend training for my new puppy.',context,channel:'chat'});
 assert.equal(newPet.knownAge,false);
});
