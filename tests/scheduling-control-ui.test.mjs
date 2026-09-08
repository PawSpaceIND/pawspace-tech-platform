import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {schedulingRuleInput} from '../lib/scheduling-rule-input.ts';
const base={name:'Quality gate',service:'grooming',zone:'blr-east',field:'rating',value:'4.7'};
test('selected zone and service reach the rule API payload',()=>{
 assert.equal(schedulingRuleInput({...base,zone:'blr-south'}).zoneId,'blr-south');
 assert.equal(schedulingRuleInput({...base,zone:'all'}).zoneId,null);
 assert.equal(schedulingRuleInput({...base,service:'dog_training'}).serviceCode,'dog_training');
 assert.equal(schedulingRuleInput(base).conditions[0].value,4.7);
});
test('invalid constraints cannot be submitted by the rule builder',()=>{
 for(const change of [{value:''},{value:'NaN'},{value:'Infinity'},{value:'6'},{name:' '},{zone:'unknown'},{service:'unknown'},{field:'capacity',value:'1.5'},{field:'qualityScore',value:'101'},{field:'model',value:'fake'}])assert.equal(schedulingRuleInput({...base,...change}),null);
 assert.equal(schedulingRuleInput({...base,field:'model',value:'commission'}).conditions[0].operator,'eq');
});
test('control panel routes real booking actions and does not advertise fictitious results',()=>{
 const source=readFileSync('app/control/scheduling-control-panel.tsx','utf8');
 assert.doesNotMatch(source,/admin-demo-PS|TST-OPS|groom_arun|8\/8|Scheduling UAT run created|setAssignmentMode/);
 assert.match(source,/href="\/team\/operations\/bookings"/);
 assert.match(source,/href="\/team\/scheduling"/);
 assert.match(source,/fetch\('\/api\/scheduling-rules',\{cache:'no-store'\}\)/);
 assert.match(source,/window.confirm/);
});
