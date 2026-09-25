import {preservedBrandStyleBytes} from './helpers/approved-brand-style.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {staffSemanticContract} from './helpers/staff-presentation-contract.mjs';
import {hasPermission} from '../lib/platform-security.ts';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const c=JSON.parse(read('tests/fixtures/staff-team-completion-contract.json'));
for(const[p,x]of Object.entries(c.files))test('Remaining Team presentation preserves non-style source: '+p,()=>assert.equal(staffSemanticContract(read(p),p),x.semantic));
test('AI rollout and campaign governance remain protected by the presentation contract',()=>{
 for(const[p,a,b]of [['app/team/ai/rollout/page.tsx','/api/ai-rollout','/api/unsafe-rollout'],['app/team/marketing/page.tsx','approve_campaign','unsafe_approve'],['app/team/daily-revenue/page.tsx','targetAmount: targetInput','targetAmount: 0'],['app/team/provider-verification/page.tsx','>{status.canTakeAssignments ?', '>{true ?']]){
  const s=read(p);assert.ok(s.includes(a));assert.notEqual(staffSemanticContract(s.replace(a,b),p),staffSemanticContract(s,p));
 }
});
test('Protected customer, partner, API, permission and database sources retain their exact bytes',()=>{
 for(const[p,h]of Object.entries(c.protected))assert.equal(hash(preservedBrandStyleBytes(p)),h,p);
});
test('Dialler styles are opt-in; the source policy and timers remain unchanged',()=>{
 for(const[p,h]of Object.entries(c.css)){const s=read(p);assert.equal(hash(s.split('\n/* STAFF TEAM COMPLETION OPT-IN:')[0]),h,p);assert.match(s,/:global\(\[data-staff-module\]\)/);}assert.match(read('app/team/sales/power-dialler/page.tsx'),/POWER_DIALLER_AUTO_ADVANCE_MS/);
});
test('Executed permission checks still deny elevated AI and marketing actions to unrelated roles',()=>{
 assert.equal(hasPermission(['customers.view'],'settings.manage'),false);assert.equal(hasPermission(['reports.view'],'marketing.manage'),false);
 assert.equal(hasPermission(['*'],'settings.manage'),true);assert.equal(hasPermission(['marketing.manage'],'marketing.manage'),true);assert.equal(hasPermission([],'users.manage'),false);
});

test('Every Team route resolves to one of the shared staff frames, including delegated pages',()=>{
 const delegates={
  'finance/food/page.tsx':['./food-finance-workspace','app/team/finance/food/food-finance-workspace.tsx'],
  'finance/sitting/page.tsx':['./sitting-finance-workspace','app/team/finance/sitting/sitting-finance-workspace.tsx'],
  'finance/taxi/page.tsx':['./taxi-finance-workspace','app/team/finance/taxi/taxi-finance-workspace.tsx'],
  'finance/walking/page.tsx':['./walking-finance-workspace','app/team/finance/walking/walking-finance-workspace.tsx'],
  'operations/bookings/page.tsx':['../../../booking-command-center/page','app/booking-command-center/page.tsx'],
  'sales/cross-sell/page.tsx':['../../../components/sales/CrossSellCommandCenter','app/components/sales/CrossSellCommandCenter.tsx'],
 };
 const pages=fs.readdirSync(new URL('../app/team',import.meta.url),{recursive:true}).filter(p=>p==='page.tsx'||p.endsWith('/page.tsx'));
 assert.ok(pages.length>=76,'The inventory must include the complete current Team route tree.');
 for(const page of pages){
  const s=read('app/team/'+page);
  if(/<(?:StaffModule|StaffWorkspace|OpsShell|TeamShell)\b/.test(s))continue;
  const target=delegates[page];assert.ok(target,'Unframed Team route: '+page);
  assert.ok(s.includes(target[0]),'The original route delegation must remain: '+page);
  assert.match(read(target[1]),/<(?:StaffModule|StaffWorkspace|OpsShell|TeamShell)\b/,'Delegated screen must use the frame: '+page);
 }
});
