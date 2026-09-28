import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {customerScopedHref,isV2CustomerPath} from '../lib/v2/route-scope.ts';
const source=readFileSync(new URL('../.github/workflows/v2-grooming.yml',import.meta.url),'utf8');
const config=readFileSync(new URL('../playwright.v2.config.ts',import.meta.url),'utf8');
function job(name){const match=source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`,'m'));assert.ok(match,`${name} job must exist`);return match[1];}
test('browser CI isolates desktop and mobile projects without deleting coverage',()=>{
 const browser=job('browser');
 assert.match(browser,/name: V2 Grooming \(\$\{\{ matrix\.project \}\}\)/);
 assert.match(browser,/fail-fast: false/);
 assert.match(browser,/project: \[chromium, mobile-chromium\]/);
 assert.match(browser,/timeout-minutes: 25/);
 assert.match(browser,/npx playwright test --config=playwright\.v2\.config\.ts --project="\$\{\{ matrix\.project \}\}"/);
 assert.doesNotMatch(browser,/continue-on-error|--grep|--pass-with-no-tests/);
 for(const file of ['v2-grooming.spec.ts','v2-customer-shell.spec.ts','v2-ui-theme-closure.spec.ts'])assert.ok(config.includes(file),file);
 assert.match(config,/workers: 1, retries: 0/);
 assert.match(browser,/name: v2-grooming-browser-contract-.*matrix\.project/);
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
