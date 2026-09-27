import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function runStagingReadPerformance({env=process.env,fetcher=fetch,read=readFile,write=writeFile,log=console.log}={}) {
const origin = String(env.STAGING_URL || '').replace(/\/$/, '');
const sha = String(env.EXPECTED_SHA || '');
const access = String(env.PAWSPACE_UAT_ACCESS_CODE || '');
if (origin !== 'https://pawspace-staging.karthik-fce.workers.dev' || !/^[a-f0-9]{40}$/.test(sha) || !access) throw Error('Certified isolated staging inputs are required');
const certification = JSON.parse(await read('staging-certification.json','utf8'));
if (certification.sha !== sha || !certification.checks?.length || certification.checks.some(c => c.ok !== true)) throw Error('Exact staging certification must pass before measuring');
async function request(path, cookie='', body) {
 const start=performance.now();
 const r=await fetcher(origin+path,{method:body?'POST':'GET',headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 const data=await r.json();
 const header=r.headers.get('server-timing')||'';
 const duration=name=>{const match=header.match(new RegExp('(?:^|,\\s*)'+name+';dur=([0-9.]+)'));return match?Number(match[1]):null;};
 const calls=header.match(/(?:^|,\s*)d1;dur=[0-9.]+;desc="(\d+) calls"/);
 return {data,response:r,timing:{appMs:duration('app'),d1TotalMs:duration('d1'),d1Calls:calls?Number(calls[1]):null},ms:Math.round((performance.now()-start)*100)/100};
}
const login=await request('/api/staging-login','',{action:'login',code:access,email:'founder@pawspace.in'});
const cookie=(login.response.headers.get('set-cookie')||'').split(';')[0];
if(!login.response.ok||!cookie)throw Error('Staging founder sign-in failed');
const to=new Date().toISOString().slice(0,10),from=new Date(Date.now()-29*86400000).toISOString().slice(0,10);
const routes=[
 {name:'availability',path:'/api/service-availability',verify:x=>Boolean(x)},
 {name:'company-analytics-30d',path:`/api/company-analytics?from=${from}&to=${to}`,verify:x=>x.data?.source==='canonical_company_metric_layer'&&!x.data?.degraded},
 {name:'ai-analytics-chat',path:'/api/ai-analytics?channel=chat',verify:x=>x.data?.conversion?.canonicalBookingLinkedThreads<=x.data?.volume?.threads&&Number.isInteger(x.data?.performance?.latencySamples)},
 {name:'grooming-finance',path:'/api/grooming-finance',verify:x=>x.scope?.limit===200&&x.scope?.dateFiltered===false&&Array.isArray(x.items)},
];
const report={sha,origin,from,to,method:'10 sequential full JSON response observations per route from one CI runner; no concurrency, CWV or production percentile claim',operations:{},failures:[]};
for(const route of routes){const samples=[],serverTiming=[];for(let i=0;i<10;i++){try{const r=await request(route.path,cookie);samples.push(r.ms);serverTiming.push(r.timing);if(!r.response.ok||!route.verify(r.data))report.failures.push({operation:route.name,status:r.response.status,kind:'response_contract'});}catch{report.failures.push({operation:route.name,kind:'request_failed'});}}
 const sorted=[...samples].sort((a,b)=>a-b);report.operations[route.name]={samplesMs:samples,serverTiming,medianMs:sorted[Math.floor(sorted.length/2)]??null,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null};
}
await write('staging-read-performance.json',JSON.stringify(report,null,2)+'\n');
log(JSON.stringify(report,null,2));
return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await runStagingReadPerformance();
 if(report.failures.length)process.exitCode=1;
}
