import {assertEmbeddedPayrollBridge} from './helpers/payroll-shell-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {featuresFor,normaliseEngagement} from '../lib/workforce-classification.ts';

test('workforce parity executes the canonical engagement policy',()=>{
 assert.equal(normaliseEngagement('contract_provider'),'contract');
 assert.equal(featuresFor('direct').surface,'employee_portal');
 assert.equal(featuresFor('contract').surface,'partner_app');
 assert.equal(featuresFor('commission').surface,'commission_dashboard');
});

test('V2 employee self-service reuses the canonical employee portal',()=>{
 const source=fs.readFileSync('app/v2/employee/page.tsx','utf8');
 assert.ok(source.includes('../../me/page')||source.includes("../../me/page"));
 assert.match(source,/export\s*\{\s*default\s*\}\s*from/);
});

test('V2 team People routes reuse canonical workforce modules instead of copying business logic',()=>{
 const wrappers={
  'app/v2/team/people/page.tsx':'../../../team/people/page',
  'app/v2/team/people/onboarding/page.tsx':'../../../../team/people/onboarding/page',
  'app/v2/team/people/time/page.tsx':'../../../../team/people/time/page',
  'app/v2/team/people/payroll/page.tsx':'../../../../team/people/payroll/page',
  'app/v2/team/people/incentives/page.tsx':'../../../../team/people/incentives/page',
  'app/v2/team/people/service-incentives/page.tsx':'../../../../team/people/service-incentives/page',
  'app/v2/team/people/manager-dashboard/page.tsx':'../../../../team/people/manager-dashboard/page',
  'app/v2/team/people/finance/page.tsx':'../../../../team/people/finance/page',
  'app/v2/team/people/reports/page.tsx':'../../../../team/people/reports/page',
  'app/v2/team/people/provider-training/page.tsx':'../../../../team/people/provider-training/page',
  'app/v2/team/performance/page.tsx':'../../../team/performance/page',
 };
 for(const [file,target] of Object.entries(wrappers)){const source=fs.readFileSync(file,'utf8');if(file==='app/v2/team/people/payroll/page.tsx'){assertEmbeddedPayrollBridge(source);continue;}assert.ok(source.includes(`export { default } from \"${target}\";`)||source.includes(`export { default } from '${target}';`),file);}
});

test('People workspace links core admin journeys into V2 Team and keeps personal employee entry separate',()=>{
 const source=fs.readFileSync('app/team/people/page.tsx','utf8');
 for(const path of ['/v2/team/people/onboarding','/v2/team/people/time','/v2/team/people/payroll','/v2/team/people/incentives','/v2/team/people/service-incentives','/v2/team/people/manager-dashboard','/v2/team/people/finance','/v2/team/people/reports','/v2/team/performance'])assert.match(source,new RegExp(path.replaceAll('/','\\/')));
 const nav=fs.readFileSync('app/components/staff-workspace/navigation.ts','utf8');
 assert.match(nav,/href: "\/v2\/employee"/);
 assert.match(nav,/href: "\/v2\/team\/people"/);
});

test('staff switcher preserves legacy Partner plus V2 Employee and V2 Partner destinations',()=>{
 const frame=fs.readFileSync('app/components/staff-workspace/StaffWorkspace.tsx','utf8');
 assert.match(frame,/href="\/v2\/employee"/);assert.match(frame,/href="\/partner"/);assert.match(frame,/href="\/v2\/partner"/);
});

test('retired V1 groomer screen cannot diverge from the canonical Partner App',()=>{
 const groomer=fs.readFileSync('app/groomer/page.tsx','utf8');
 const v2Partner=fs.readFileSync('app/v2/partner/page.tsx','utf8');
 assert.match(groomer,/redirect\("\/partner-app"\)/);assert.match(v2Partner,/partner-app\/page/);
});

test('manager dashboard trainer classification is canonical, not title heuristic',()=>{
 const source=fs.readFileSync('lib/manager-dashboard.ts','utf8');
 assert.match(source,/provider_people_links/);assert.match(source,/services_json/);assert.match(source,/provider_people_link/);assert.doesNotMatch(source,/title_heuristic/);
});
