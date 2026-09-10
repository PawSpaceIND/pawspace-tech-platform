import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePetNextBestService} from '../lib/services/pet-next-best-service.ts';
const base = {pet:{petId:'P',species:'dog',ageMonths:12},serviceHistory:[{serviceCode:'grooming',completedCount:1}],statedIntent:['training']};
test('Grooming to Training follows stated intent',()=>assert.ok(evaluatePetNextBestService(base).some(r=>r.targetService==='training')));
test('Boarding recommends Taxi',()=>assert.ok(evaluatePetNextBestService({...base,serviceHistory:[{serviceCode:'boarding',completedCount:1}]}).some(r=>r.targetService==='taxi')));
for(const patch of [{hasOpenComplaint:true},{hasUnresolvedRefund:true},{activeEntitlements:{training:1}},{pet:{...base.pet,serviceSafetyEligibility:{training:false}}},{serviceHistory:[...base.serviceHistory,{serviceCode:'training',completedCount:0,futureBookingAt:Date.now()+86400000}]}]) test(`suppression ${JSON.stringify(patch)}`,()=>assert.equal(evaluatePetNextBestService({...base,...patch}).some(r=>r.targetService==='training'),false));
test('invalid pet age cannot trigger a young-dog recommendation',()=>assert.equal(evaluatePetNextBestService({...base,pet:{...base.pet,ageMonths:-1},serviceHistory:[{serviceCode:'training',completedCount:1}]}).some(r=>r.targetService==='grooming'),false));
test('overlapping service histories produce only one Taxi recommendation',()=>{
 const result=evaluatePetNextBestService({...base,statedIntent:['taxi'],serviceHistory:[...base.serviceHistory,{serviceCode:'boarding',completedCount:1}]});
 assert.equal(result.filter(r=>r.targetService==='taxi').length,1);
});
test('outbound journey recommendations cannot bypass safety or future-booking suppression',async()=>{
 const {installWorkersHooks}=await import('./helpers/module-hooks.mjs');installWorkersHooks('__NBS_CLOSURE_DB__');
 const {evaluateOutboundNextBestService}=await import('../lib/outbound-next-best-service.ts');
 const input={pet:{petId:'P',species:'dog',ageMonths:10,serviceSafetyEligibility:{training:false}},serviceHistory:[]};
 assert.equal(evaluateOutboundNextBestService(input).some(r=>r.targetService==='training'),false);
 assert.equal(evaluateOutboundNextBestService({...input,pet:{...input.pet,serviceSafetyEligibility:{}},serviceHistory:[{serviceCode:'training',completedCount:0,futureBookingAt:Date.now()+86400000}]}).some(r=>r.targetService==='training'),false);
});
