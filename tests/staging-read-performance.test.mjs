import test from 'node:test';
import assert from 'node:assert/strict';
import {runStagingReadPerformance} from '../scripts/ops/staging-read-performance.mjs';
const sha='a'.repeat(40);
async function run({origin='https://pawspace-staging.karthik-fce.workers.dev',certificateSha=sha,fail=false}={}) {
 let output='',saved='',requests=0;
 const report=await runStagingReadPerformance({env:{STAGING_URL:origin,EXPECTED_SHA:sha,PAWSPACE_UAT_ACCESS_CODE:'ACCESS_DO_NOT_LOG'},read:async()=>JSON.stringify({sha:certificateSha,checks:[{ok:true}]}),write:async(_,s)=>{saved=s;},log:s=>{output=s;},fetcher:async(url,options)=>{
 requests++;
 if(url.endsWith('/api/staging-login'))return Response.json({},{headers:{'set-cookie':'session=DO_NOT_LOG; HttpOnly'}});
 assert.equal(options.method,'GET');
 if(fail)return Response.json({error:'PRIVATE_DATA_DO_NOT_LOG'},{status:500});
 const headers={'server-timing':'app;dur=120, d1;dur=90;desc="9 calls"'};
 if(url.includes('company-analytics'))return Response.json({data:{source:'canonical_company_metric_layer',degraded:null}},{headers});
 if(url.includes('ai-analytics'))return Response.json({data:{conversion:{canonicalBookingLinkedThreads:1},volume:{threads:2},performance:{latencySamples:2}}},{headers});
 if(url.includes('grooming-finance'))return Response.json({scope:{limit:200,dateFiltered:false},items:[]},{headers});
 return Response.json({services:[]},{headers});
 }});
 return {report,output,saved,requests};
}
test('performance probe refuses production and mismatched certified builds',async()=>{for(const input of [{origin:'https://pawspace.in'},{certificateSha:'b'.repeat(40)}])await assert.rejects(run(input),/staging/i);});
test('performance probe records bounded read samples and numeric server timing without credentials',async()=>{const r=await run();assert.equal(r.requests,41);assert.equal(Object.keys(r.report.operations).length,4);assert.ok(Object.values(r.report.operations).every(x=>x.samplesMs.length===10));assert.deepEqual(r.report.operations['grooming-finance'].serverTiming[0],{appMs:120,d1TotalMs:90,d1Calls:9});assert.deepEqual(r.report.failures,[]);assert.doesNotMatch(r.output+r.saved,/DO_NOT_LOG|set-cookie/);});
test('API failure is visible but private response text is never in the report',async()=>{const r=await run({fail:true});assert.equal(r.report.failures.length,40);assert.doesNotMatch(r.output+r.saved,/PRIVATE_DATA|DO_NOT_LOG/);});
