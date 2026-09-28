import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {customerScopedHref,isV2CustomerPath} from '../lib/v2/route-scope.ts';
const source=readFileSync(new URL('../.github/workflows/v2-grooming.yml',import.meta.url),'utf8');
const config=readFileSync(new URL('../playwright.v2.config.ts',import.meta.url),'utf8');
function job(name){const match=source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`,'m'));assert.ok(match,`${name} job must exist`);return match[1];}
test('browser CI isolates desktop and mobile projects without deleting coverage',()=>{
 const browser=job('browser');
 assert.match(browser,/name: V2 Grooming \(\$\{\{ matrix\.project \}\}, shard \$\{\{ matrix\.shard \}\}\/4\)/);
 assert.match(browser,/fail-fast: false/);
 assert.match(browser,/project: \[chromium, mobile-chromium\]/);
 assert.match(browser,/timeout-minutes: 25/);
 assert.match(browser,/shard: \[1, 2, 3, 4\]/);
 assert.match(browser,/max-parallel: 4/);
 assert.match(config,/fullyParallel: true/);
 assert.match(browser,/npx playwright test --config=playwright\.v2\.config\.ts --project="\$\{\{ matrix\.project \}\}" --shard="\$\{\{ matrix\.shard \}\}\/4"/);
 assert.doesNotMatch(browser,/continue-on-error|--grep|--pass-with-no-tests/);
 for(const file of ['v2-grooming.spec.ts','v2-customer-shell.spec.ts','v2-ui-theme-closure.spec.ts'])assert.ok(config.includes(file),file);
 assert.match(config,/workers: 1, retries: 0/);
 assert.match(browser,/name: v2-grooming-browser-contract-.*matrix\.project/);
 assert.match(browser,/name: v2-grooming-browser-contract-.*matrix\.project.*matrix\.shard/);
});
test('the original browser check name remains a required-result aggregation gate',()=>{
 const gate=job('browser-gate');
 assert.match(gate,/name: V2 Grooming desktop and mobile\n/);
 assert.match(gate,/needs: browser/);assert.match(gate,/if: \$\{\{ always\(\) \}\}/);
 assert.match(gate,/BROWSER_RESULT: \$\{\{ needs\.browser\.result \}\}/);
 assert.doesNotMatch(gate,/continue-on-error/);
});
for(const result of ['success','failure','cancelled','skipped','', 'unknown'])test(`browser aggregation accepts only actual success: ${result||'missing'}`,()=>{
 const gate=job('browser-gate'),match=gate.match(/        run: \|\n([\s\S]*)$/);
 assert.ok(match,'Execute the workflow-owned gate rather than a duplicate test implementation');
 const script=match[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const execution=spawnSync('bash',['-e','-c',script],{env:{...process.env,BROWSER_RESULT:result},encoding:'utf8',timeout:5000});
 assert.ifError(execution.error);
 assert.equal(execution.status===0,result==='success',`${result}: ${execution.stdout}${execution.stderr}`);
});

test('browser workflow covers the real V2 grooming route scope',()=>{
 assert.equal(isV2CustomerPath('/v2/grooming'),true);
 assert.equal(customerScopedHref('/v2/grooming','/grooming/manage?bookingId=BOOK-1'),'/v2/grooming/manage?bookingId=BOOK-1');
});

// Ask the installed runner to register the real specs; no browser or API request is executed by --list.
function listedCases(args = []) {
 const execution=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config=playwright.v2.config.ts','--list','--reporter=json',...args],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024,
  env:{...process.env,PW_BASE_URL:'http://127.0.0.1:4196',PLAYWRIGHT_JSON_OUTPUT_NAME:'',PLAYWRIGHT_JSON_OUTPUT_FILE:''},
 });
 assert.ifError(execution.error);
 assert.equal(execution.status,0,execution.stderr);
 const report=JSON.parse(execution.stdout);assert.deepEqual(report.errors,[]);
 const cases=[];
 const visit=suite=>{for(const spec of suite.specs||[])for(const item of spec.tests||[])cases.push({
  key:JSON.stringify([item.projectName,spec.file,spec.id]),project:item.projectName,file:spec.file,
 });for(const child of suite.suites||[])visit(child);};
 for(const suite of report.suites)visit(suite);
 return{cases,config:report.config};
}

test('actual Playwright inventory is covered exactly once across all device shards',{timeout:180000},()=>{
 const workflow=yaml.load(source),matrix=workflow.jobs.browser.strategy.matrix;
 assert.deepEqual(matrix.project,['chromium','mobile-chromium']);
 assert.deepEqual(matrix.shard,[1,2,3,4]);
 const complete=listedCases(),all=complete.cases;
 assert.equal(complete.config.fullyParallel,true,'file-level sharding would leave the large route spec in one job');
 assert.equal(complete.config.workers,1,'each runner remains serial');
 assert.ok(complete.config.projects.every(project=>project.retries===0));
 assert.deepEqual([...new Set(all.map(item=>item.file))].sort(),['v2-customer-shell.spec.ts','v2-grooming.spec.ts','v2-ui-theme-closure.spec.ts']);
 const assigned=[];
 for(const project of matrix.project){
  const expected=all.filter(item=>item.project===project);assert.ok(expected.length>0);
  const counts=[];
  for(const shard of matrix.shard){
   const part=listedCases([`--project=${project}`,`--shard=${shard}/${matrix.shard.length}`]);
   assert.ok(part.cases.length>0,`${project}/${shard} must execute tests`);
   assert.ok(part.cases.every(item=>item.project===project));
   assert.ok(part.cases.length<=Math.ceil(expected.length/matrix.shard.length),`${project}/${shard} is not test-level balanced`);
   assigned.push(...part.cases);counts.push(part.cases.length);
  }
  console.log(`${project}: ${expected.length} registered cases -> shards ${counts.join(', ')}`);
 }
 const keys=items=>items.map(item=>item.key).sort();
 assert.equal(new Set(assigned.map(item=>item.key)).size,assigned.length,'no duplicated case');
 assert.deepEqual(keys(assigned),keys(all),'every original case and device must remain covered');
});
