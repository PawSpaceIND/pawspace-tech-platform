import {fileURLToPath} from 'node:url';
export const SLOT_TIMES=[1790940300000,1790940600000,1790940900000,1790941200000,1790941500000,1790941800000,1790942100000,1790942400000];
export function scheduledQuery(){return {queryId:'atlas-eight-slots-readonly',dry:true,view:'events',limit:200,timeframe:{from:SLOT_TIMES[0],to:SLOT_TIMES.at(-1)+360000},parameters:{datasets:['cloudflare-workers'],filterCombination:'and',filters:[{key:'$metadata.service',type:'string',operation:'eq',value:'pawspace-staging'}],needle:{value:'scheduled|cron',isRegex:true,matchCase:false}}};}
function category(value){const s=String(value||'');return /cpu.*limit|exceeded.*cpu/i.test(s)?'cpu_limit':/subrequest.*limit|too many.*subrequest/i.test(s)?'subrequest_limit':/timeout|timed out|time limit|canceled/i.test(s)?'timeout_or_canceled':/auth|permission|access denied/i.test(s)?'authorization':s?'other_error':null;}
export function sanitizeEvent(ev){const m=ev?.$metadata||{},w=ev?.$workers||ev?.source?.$workers||{},event=w.event||{};const result={metadata:{},worker:{},event:{}};
 for(const k of ['timestamp','startTime','endTime','duration','statusCode'])if(typeof m[k]==='number')result.metadata[k]=m[k];
 if(/^[A-Za-z0-9_-]{1,128}$/.test(m.id||''))result.metadata.id=m.id;
 if(m.service==='pawspace-staging')result.metadata.service=m.service;
 for(const k of ['type','level','origin'])if(['cron','scheduled','invocation','log','error','warn','info','debug','cloudflare'].includes(m[k]))result.metadata[k]=m[k];
 if(/^[0-9*\/, -]{5,80}$/.test(m.trigger||''))result.metadata.trigger=m.trigger;
 for(const k of ['cpuTimeMs','wallTimeMs'])if(typeof w[k]==='number')result.worker[k]=w[k];
 if(['ok','exception','exceededCpu','exceededMemory','canceled','unknown','internalError'].includes(w.outcome))result.worker.outcome=w.outcome;
 if(['cron','scheduled'].includes(w.eventType))result.worker.eventType=w.eventType;
 if(['cron','scheduled'].includes(event.type))result.event.type=event.type;
 if(/^[0-9*\/, -]{5,80}$/.test(event.cron||''))result.event.cron=event.cron;
 if(typeof event.scheduledTime==='number')result.event.scheduledTime=event.scheduledTime;
 result.errorCategory=category(m.error||m.message||w.exceptions?.[0]?.message);return result;}
export function sanitizeResponse(d){const r=d?.result||{};return {success:d?.success===true,errorCodes:(d?.errors||[]).map(x=>x.code),errorCategories:(d?.errors||[]).map(x=>category(x.message)),resultKeys:Object.keys(r),statistics:r.statistics?Object.fromEntries(['bytes_read','elapsed','rows_read','abr_level'].filter(k=>typeof r.statistics[k]==='number').map(k=>[k,r.statistics[k]])):null,eventCount:r.events?.count??null,events:(r.events?.events||[]).map(sanitizeEvent),cursor:r.events?.events?.at(-1)?.$metadata?.id||null};}
export async function main(){const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;if(!token||!account)throw new Error('Existing environment credential required');
 const query=scheduledQuery();const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(query),signal:AbortSignal.timeout(30000)});const d=await response.json();const receipt={readAt:new Date().toISOString(),httpStatus:response.status,request:query,...sanitizeResponse(d),modelCalls:0,schedulerInvocations:0,productWrites:0};
 // Emit only the sanitized receipt. The workflow owns the fixed artifact path, so network-derived
 // values never become a filesystem sink inside this process.
 process.stdout.write(JSON.stringify(receipt,null,2));process.stderr.write(JSON.stringify({httpStatus:receipt.httpStatus,success:receipt.success,eventCount:receipt.eventCount,errorCodes:receipt.errorCodes})+'\n');if(!response.ok||!receipt.success)throw new Error('Historical scheduled log query blocked; sanitized receipt emitted');}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await main();
