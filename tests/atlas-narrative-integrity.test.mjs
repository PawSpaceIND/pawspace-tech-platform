import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_ANSWER_SCOPE, atlasDraftCompletionFailure, atlasFinancialClaimsFit, atlasOperationalFacts } from '../lib/intelligence/atlas-narrative-integrity.ts';
const metric=value=>({value,source:'synthetic fixture',asOf:1000});
const snapshot={asOf:1000,mission:metric({target:1000,booked:500,collected:400,net:400,percent:40}),ops:{open_cases:metric(10),sla_breaches:metric(3),sitting_pending_accepts:metric(1),boarding_pending_accepts:metric(2)},finance:{invoice_completed_gap:metric({completed_jobs:4,issued_invoices:3,gap:1}),trainer_earnings:metric(null)}};
const missing={...snapshot,mission:{...metric(null),reason:'current_mission_not_found'}};
for(const narrative of ['Achieved 75% of target.','75% achieved.','**Collected**: INR 9,000.','Collected INR 400. Collected INR 9000.','Collected INR 9 lakh.','INR 9 lakh collected.','Target INR 500.','Net: INR 1,000.'])
  test(`numeric guard rejects: ${narrative}`,()=>assert.equal(atlasFinancialClaimsFit(snapshot,narrative).ok,false));
for(const narrative of ['Collected INR 9000000.','100% achieved.','Target INR 1000.','INR 9000000 collected.'])
  test(`missing-data guard rejects: ${narrative}`,()=>assert.equal(atlasFinancialClaimsFit(missing,narrative).ok,false));
test('allows supported and tightened figures without changing authority',()=>{
 assert.equal(atlasFinancialClaimsFit(snapshot,'Collected INR 400; achieved 40%; target INR 1000.').ok,true);
 assert.equal(atlasFinancialClaimsFit(snapshot,'Collected INR 390; achieved 39%.').ok,true);
 assert.equal(atlasFinancialClaimsFit(missing,'Current mission data is unavailable.').ok,true);
 assert.equal(ATLAS_ANSWER_SCOPE.internalArtifacts.length,6);
 assert.ok(ATLAS_ANSWER_SCOPE.humanGated.includes('refund'));
});
test('detects both providers token/incomplete termination signals',()=>{
 for(const reason of ['max_tokens','length','incomplete','content_filter','refusal','tool_use','unknown',null])assert.equal(atlasDraftCompletionFailure(reason),'narrative_incomplete');
 for(const reason of ['end_turn','completed','stop'])assert.equal(atlasDraftCompletionFailure(reason),null);
});
test('fallback retains operational facts even without mission or model output',()=>{
 const text=atlasOperationalFacts(missing);assert.match(text,/Open cases: 10/);assert.match(text,/SLA breaches: 3/);assert.match(text,/Trainer earnings readiness: unknown/);assert.match(text,/Source: synthetic fixture/);
});
for (const narrative of ['Achievement: 75 percent.', '| Achieved (%) | 75 |', 'Net collected: INR 900.', 'Collected: Rs. 9 cr.', 'Collected: INR 9m.', 'INR 2,000 target.', 'Collected -1 INR.', 'Target: 1.2e6.'])
  test(`financial guard refuses ambiguous or unsupported format: ${narrative}`,()=>assert.equal(atlasFinancialClaimsFit(snapshot,narrative).ok,false));
test('supported markdown table, Indian units and net-collected labels remain usable',()=>{
  assert.equal(atlasFinancialClaimsFit(snapshot,'| Collected | INR 400 |\n| Achieved (%) | 40 |\nNet collected: INR 400.').ok,true);
  assert.equal(atlasFinancialClaimsFit(snapshot,'Target: INR 0.01 lakh; collected INR 0.004 lakh.').ok,true);
});
