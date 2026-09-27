import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const entry=new URL('../scripts/ops/staging-read-performance.mjs',import.meta.url).href;
const sha='a'.repeat(40);
function run({origin='https://pawspace-staging.karthik-fce.workers.dev',certificateSha=sha,fail=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'pawspace-perf-'));
 writeFileSync(join(dir,'staging-certification.json'),JSON.stringify({sha:certificateSha,checks:[{ok:true}]}));
 const source=`globalThis.fetch=async(url,options)=>{if(url.endsWith('/api/staging-login'))return Response.json({},{headers:{'set-cookie':'session=DO_NOT_LOG; HttpOnly'}});if(options.method!=='GET')throw Error('Unexpected write');if(${fail})return Response.json({error:'PRIVATE_DATA_DO_NOT_LOG'},{status:500});if(url.includes('company-analytics'))return Response.json({data:{source:'canonical_company_metric_layer',degraded:null}});if(url.includes('ai-analytics'))return Response.json({data:{conversion:{canonicalBookingLinkedThreads:1},volume:{threads:2},performance:{latencySamples:2}}});if(url.includes('grooming-finance'))return Response.json({scope:{limit:200,dateFiltered:false},items:[]});return Response.json({services:[]});};await import(${JSON.stringify(entry)});`;
 const p=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:dir,encoding:'utf8',env:{...process.env,STAGING_URL:origin,EXPECTED_SHA:sha,PAWSPACE_UAT_ACCESS_CODE:'ACCESS_DO_NOT_LOG'}});
 let report;try{report=JSON.parse(readFileSync(join(dir,'staging-read-performance.json'),'utf8'));}catch{}
 rmSync(dir,{recursive:true,force:true});return {...p,report};
}
test('performance probe refuses production and mismatched certified builds before sign-in',()=>{for(const input of [{origin:'https://pawspace.in'},{certificateSha:'b'.repeat(40)}]){const r=run(input);assert.notEqual(r.status,0);assert.equal(r.report,undefined);}});
test('performance probe records bounded read samples without serializing credentials or data',()=>{const r=run();assert.equal(r.status,0,r.stderr);assert.equal(Object.keys(r.report.operations).length,4);assert.ok(Object.values(r.report.operations).every(x=>x.samplesMs.length===10));assert.deepEqual(r.report.failures,[]);assert.doesNotMatch(r.stdout,/DO_NOT_LOG|set-cookie/);});
test('API failure is visible but private response text is never in the report',()=>{const r=run({fail:true});assert.equal(r.status,1);assert.equal(r.report.failures.length,40);assert.doesNotMatch(r.stdout,/PRIVATE_DATA|DO_NOT_LOG/);});
