import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
import {partnerJobWorkspaceHref} from '../lib/partner-job-workspace.ts';
import {acceptWalkingReplacement} from '../lib/walking-recovery-client.ts';
import {acceptTaxiReplacement} from '../lib/taxi-recovery-client.ts';
const root=new URL('../',import.meta.url),read=file=>fs.readFileSync(new URL(file,root));
const contract=JSON.parse(read('tests/fixtures/partner-services-presentation-contract.json'));
const hash=value=>createHash('sha256').update(value).digest('hex');
for(const file of contract.layouts)test('Partner presentation-only layout: '+file,()=>{
 const text=read(file).toString();assert.match(text,/return <PartnerModule>\{children\}<\/PartnerModule>/);
 assert.doesNotMatch(text,/fetch\(|useEffect|useState|localStorage|redirect\(|middleware|cookies\(/);
});
test('Every pre-existing application source and engine remains byte-identical',()=>{
 for(const [file,expected] of Object.entries(contract.protected))assert.equal(hash(read(file)),expected,file);
});
test('New Partner frame adds no staff request, assumed identity, or permission grant',()=>{
 const text=read('app/components/partner-presentation/PartnerModule.tsx').toString();
 assert.doesNotMatch(text,/fetch\(|useEffect|useState|localStorage|sessionStorage|team-overview|settings\.manage|dashboard\.view/);
 for(const href of ['/partner','/partner/jobs','/partner/workspace','/partner/onboarding'])assert.ok(text.includes('href="'+href+'"'));
 assert.match(text,/prefetch=\{false\}/);assert.match(text,/data-partner-presentation/);
});
test('Partner stylesheet is scoped, uses the existing palette and never hides business controls',()=>{
 const css=read('app/components/partner-presentation/partner-presentation.module.css').toString(),tree=postcss.parse(css);
 tree.walkRules(rule=>assert.ok(rule.selectors.every(selector=>/\.(frame|topbar|logo|navigation|skip|content)\b/.test(selector)),rule.selector));
 assert.match(css,/composes:palette from "\.\.\/brand\/brand-surface\.module\.css"/);
 assert.doesNotMatch(css,/display\s*:\s*none|visibility\s*:\s*hidden|https?:\/\/|javascript:/);
});
test('Executed service routing retains encoded booking context and rejects unknown destinations',()=>{
 const id='TEST / booking?1',encoded=encodeURIComponent(id);
 for(const [service,route] of Object.entries({grooming:'/partner-app',dog_training:'/trainer',boarding:'/host',pet_sitting:'/sitter',pet_taxi:'/driver',dog_walking:'/walker',pet_walking:'/walker'}))
  assert.equal(partnerJobWorkspaceHref({serviceCode:service,bookingId:id}),route+'?bookingId='+encoded);
 assert.equal(partnerJobWorkspaceHref({serviceCode:'grooming',bookingId:''}),null);
 assert.equal(partnerJobWorkspaceHref({serviceCode:'unknown',bookingId:id}),null);
});
test('Executed recovery clients retain booking identity and propagate refusal without success',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({error:'Not assigned to this provider'},{status:403});};
 try{
  await assert.rejects(acceptWalkingReplacement({bookingId:'UI-WALK',idempotencyKey:'UI-WALK-KEY'}),/Not assigned/);
  await assert.rejects(acceptTaxiReplacement({bookingId:'UI-TAXI',idempotencyKey:'UI-TAXI-KEY'}),/Not assigned/);
  assert.deepEqual(calls,[{url:'/api/walking-recovery',body:{bookingId:'UI-WALK',idempotencyKey:'UI-WALK-KEY'}},{url:'/api/taxi-recovery',body:{bookingId:'UI-TAXI',idempotencyKey:'UI-TAXI-KEY'}}]);
 }finally{globalThis.fetch=original;}
});
