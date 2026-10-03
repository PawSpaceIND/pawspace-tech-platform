import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {trainingVideoValidation,trainingHandoverReminder,trainingHomeworkStatus} from '../app/trainer/lifecycle-presentation.ts';
test('video selection is bounded, rejects empty/unsupported files and accepts boundary',()=>{
 assert.equal(trainingVideoValidation({type:'video/mp4',size:10_000_000}),true);
 assert.equal(trainingVideoValidation({type:'video/webm',size:1}),true);
 for(const file of [{type:'video/mp4',size:10_000_001},{type:'image/jpeg',size:100},{type:'video/mp4',size:0},{type:'video/mp4',size:NaN}])assert.equal(trainingVideoValidation(file),false);
});
test('handover reminder begins at server start plus50min, never from scheduled date',()=>{
 const due=1_800_000_000_000;
 assert.equal(trainingHandoverReminder(due,due-1),false);
 assert.equal(trainingHandoverReminder(due,due),true);
 assert.equal(trainingHandoverReminder(null,due),false);
 assert.equal(trainingHandoverReminder(undefined,due),false);
});
test('availability never claims parent read or acknowledgement',()=>{
 assert.match(trainingHomeworkStatus('available'),/acknowledgement is pending/);
 assert.match(trainingHomeworkStatus('acknowledged'),/acknowledged/);
 assert.match(trainingHomeworkStatus(undefined),/Save the report/);
 assert.doesNotMatch(trainingHomeworkStatus('available'),/read|delivered/);
});
test('trainer boundary wires server navigation, separate labelled simulation and explicit handover',()=>{
 const source=readFileSync(new URL('../app/trainer/page.tsx',import.meta.url),'utf8');
 assert.match(source,/currentContext\.navigation\.mapsUrl/);
 assert.match(source,/simulation\.eligible&&currentContext\.arrival\.simulation\.approvalId/);
 assert.match(source,/simulatedArrival:\{approvalId:/);
 assert.match(source,/ownerHandoverCompleted:true/);
 assert.match(source,/Confirm arrival with device GPS/);
 assert.match(source,/arrival\.evidence\?\.simulated&&<p role="status">Sandbox arrival simulation — not a physical visit/);
 const proof=readFileSync(new URL('../app/trainer/session-proof.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(proof,/min="15"|at least 15/);
 assert.match(proof,/asset\.objectStored===true&&asset\.proofReady/);
});
