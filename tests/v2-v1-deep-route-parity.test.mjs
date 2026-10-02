import {assertEmbeddedPayrollBridge} from './helpers/payroll-shell-review.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {customerScopedHref,isV2CustomerPath} from "../lib/v2/route-scope.ts";

const root=new URL("../",import.meta.url);
const appPath=(rel)=>new URL(rel,root);
const listPages=(dir)=>{
  const base=appPath(dir);
  const walk=(disk,rel="")=>fs.readdirSync(disk,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(disk,entry.name),path.join(rel,entry.name)):entry.name==="page.tsx"?[path.join(rel,"page.tsx")]:[]);
  return walk(base.pathname);
};

test("every canonical Team page has a V2 route bridge",()=>{
  const legacy=listPages("app/team");
  for(const rel of legacy){
    const target=`app/v2/team/${rel}`;
    assert.equal(fs.existsSync(appPath(target)),true,target);
    const source=fs.readFileSync(appPath(target),"utf8");
    if(rel==='people/payroll/page.tsx'){assertEmbeddedPayrollBridge(source);continue;}
    assert.match(source,/V2 route bridge/);
    assert.match(source,/export \{ default \} from/);
  }
});

test("V2 exposes canonical founder, system-integration and assisted-booking workspaces",()=>{
  for(const file of ["app/v2/control/page.tsx","app/v2/system-integration/page.tsx","app/v2/assisted-booking/page.tsx"]){
    assert.equal(fs.existsSync(appPath(file)),true,file);
    assert.match(fs.readFileSync(appPath(file),"utf8"),/export \{ default \} from/);
  }
});

test("workspace hub exposes People, Scheduling, Founder Control, Systems and Assisted Booking",()=>{
  const hub=fs.readFileSync(appPath("app/v2/workspaces/page.tsx"),"utf8");
  for(const href of ["/v2/team/people","/v2/team/scheduling","/v2/control","/v2/system-integration","/v2/assisted-booking"])
    assert.ok(hub.includes(`href:\"${href}\"`),href);
});
test("V2 routing module executes for parity coverage",()=>{assert.equal(isV2CustomerPath("/v2/team/people"),true);assert.equal(customerScopedHref("/v2/training","/training"),"/v2/training");});
