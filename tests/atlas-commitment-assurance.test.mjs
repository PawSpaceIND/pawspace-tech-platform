import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAtlasCommitmentAssurance} from '../lib/intelligence/atlas-commitment-assurance.ts';

const now=2_000_000_000_000;
const base={proposalId:'P1',title:'Close launch evidence',ownerRole:'founder',expectedOutcome:'Evidence reviewed',createdBy:'f',createdAt:now-1000,updatedBy:'f',updatedAt:now-1000,closedAt:null,trackingOnly:true,externalMutation:false,authorityMutationAllowed:false,executionMutationAllowed:false};

test('Atlas commitment assurance distinguishes overdue due-soon on-track and closed without verifying outcomes',()=>{
 const rows=buildAtlasCommitmentAssurance([
  {...base,id:'C1',dueAt:now-1,status:'open',overdue:true},
  {...base,id:'C2',dueAt:now+60*60*1000,status:'open',overdue:false},
  {...base,id:'C3',dueAt:now+72*60*60*1000,status:'open',overdue:false},
  {...base,id:'C4',dueAt:now-1,status:'completed',overdue:false,closedAt:now-100}
 ],{now,dueSoonMs:24*60*60*1000});
 assert.deepEqual(Object.fromEntries(rows.map(x=>[x.commitmentId,x.state])),{C1:'overdue',C2:'due_soon',C3:'on_track',C4:'closed'});
 const overdue=rows.find(x=>x.commitmentId==='C1');
 assert.equal(overdue.requiresFounderAttention,true);
 assert.equal(overdue.outcomeVerified,false);
 assert.equal(overdue.automaticResolutionAllowed,false);
 assert.equal(overdue.executionMutationAllowed,false);
});

test('Atlas commitment assurance is wired into snapshot API and Founder cockpit',async()=>{
 const fs=await import('node:fs');
 const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8');
 const cockpit=fs.readFileSync(new URL('../lib/intelligence/atlas-founder-cockpit.ts',import.meta.url),'utf8');
 assert.match(route,/buildAtlasCommitmentAssurance\(decisionCommitments\)/);
 assert.match(route,/commitmentAssurance,founderCockpit/);
 assert.match(cockpit,/kind:"commitment"/);
 assert.match(cockpit,/commitment_deadline_overdue/);
 assert.match(cockpit,/automaticResolutionAllowed:false/);
});
