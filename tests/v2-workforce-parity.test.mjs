import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wrappers={
 'app/v2/employee/page.tsx':'../../me/page',
 'app/v2/employee/people/page.tsx':'../../../team/people/page',
 'app/v2/employee/onboarding/page.tsx':'../../../team/people/onboarding/page',
 'app/v2/employee/time/page.tsx':'../../../team/people/time/page',
 'app/v2/employee/payroll/page.tsx':'../../../team/people/payroll/page',
 'app/v2/employee/incentives/page.tsx':'../../../team/people/incentives/page',
 'app/v2/employee/service-incentives/page.tsx':'../../../team/people/service-incentives/page',
 'app/v2/employee/manager-dashboard/page.tsx':'../../../team/people/manager-dashboard/page',
 'app/v2/employee/finance/page.tsx':'../../../team/people/finance/page',
 'app/v2/employee/reports/page.tsx':'../../../team/people/reports/page',
 'app/v2/employee/provider-training/page.tsx':'../../../team/people/provider-training/page',
 'app/v2/employee/performance/page.tsx':'../../../team/performance/page',
};

test('V2 employee routes reuse canonical workforce modules instead of copying business logic',()=>{
 for(const [file,target] of Object.entries(wrappers)){
  const source=fs.readFileSync(file,'utf8').trim();
  assert.equal(source,`export { default } from '${target}';`,file);
 }
});

test('People workspace links core employee journeys into V2',()=>{
 const source=fs.readFileSync('app/team/people/page.tsx','utf8');
 for(const path of ['/v2/employee/onboarding','/v2/employee/time','/v2/employee/payroll','/v2/employee/incentives','/v2/employee/service-incentives','/v2/employee/manager-dashboard','/v2/employee/finance','/v2/employee/reports','/v2/employee/performance'])assert.match(source,new RegExp(path.replaceAll('/','\\/')));
});

test('staff navigation exposes V2 employee and partner experiences while preserving legacy aliases',()=>{
 const nav=fs.readFileSync('app/components/staff-workspace/navigation.ts','utf8');
 for(const path of ['/v2/employee','/v2/employee/people','/v2/employee/payroll','/v2/employee/incentives','/v2/employee/service-incentives','/v2/employee/manager-dashboard'])assert.match(nav,new RegExp(path.replaceAll('/','\\/')));
 const frame=fs.readFileSync('app/components/staff-workspace/StaffWorkspace.tsx','utf8');
 assert.match(frame,/href="\/v2\/employee"/);assert.match(frame,/href="\/v2\/partner"/);
});

test('retired V1 groomer screen cannot diverge from the canonical Partner App',()=>{
 const groomer=fs.readFileSync('app/groomer/page.tsx','utf8');
 const v2Partner=fs.readFileSync('app/v2/partner/page.tsx','utf8');
 assert.match(groomer,/redirect\("\/partner-app"\)/);
 assert.match(v2Partner,/partner-app\/page/);
});

test('manager dashboard trainer classification is canonical, not title heuristic',()=>{
 const source=fs.readFileSync('lib/manager-dashboard.ts','utf8');
 assert.match(source,/provider_people_links/);
 assert.match(source,/services_json/);
 assert.match(source,/provider_people_link/);
 assert.doesNotMatch(source,/title_heuristic/);
});
