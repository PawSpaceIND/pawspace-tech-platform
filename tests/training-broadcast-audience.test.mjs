import test from 'node:test';
import assert from 'node:assert/strict';
import{trainingBroadcastAudience}from '../lib/training-broadcast-audience.ts';
const p=(id,model)=>({id,model});
const e=(providerId,eligible,score=1)=>({providerId,eligible,score,workload:0,distanceKm:2,reasons:[],residualCapacity:1});
const decision=(...evaluations)=>({evaluations,provider:null,mode:'manual_review',occurrences:[],shortlist:[],explanation:[]});
test('eligible full-time provider wins before contractor broadcast',()=>{
 assert.deepEqual(trainingBroadcastAudience(decision(e('ct1',true,99),e('ft1',true,1)),[p('ct1','commission'),p('ft1','full_time')]),{mode:'full_time',providerId:'ft1',contractorIds:[]});
});
test('all eligible contractors enter audience, ineligible roster/travel result excluded',()=>{
 assert.deepEqual(trainingBroadcastAudience(decision(e('ct2',true),e('ct1',true),e('ct3',false)),[p('ct1','commission'),p('ct2','commission'),p('ct3','commission')]),{mode:'broadcast',providerId:null,contractorIds:['ct1','ct2']});
});
test('no eligible provider goes to Operations, with no invented assignment',()=>{
 assert.deepEqual(trainingBroadcastAudience(decision(e('ct1',false)),[p('ct1','commission')]),{mode:'needs_operations',providerId:null,contractorIds:[]});
});

test('unresolved eligible provider fails closed and duplicate contractor IDs do not send duplicate offers',()=>{
 assert.equal(trainingBroadcastAudience(decision(e('ct1',true),e('ft-missing',true)),[p('ct1','commission')]).mode,'needs_operations');
 assert.deepEqual(trainingBroadcastAudience(decision(e('ct1',true),e('ct1',true)),[p('ct1','commission')]).contractorIds,['ct1']);
});
