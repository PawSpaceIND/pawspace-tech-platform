import assert from 'node:assert/strict';
import { installWorkersHooks } from './module-hooks.mjs';
import * as h from './stay-taxi-latency-harness.mjs';
installWorkersHooks('__STAY_GC_DB__','__STAY_GC_ENV__');
h.stubGeocoding();
const scheduling = await import('../../app/api/uat-scheduling/route.ts');
const w=await h.stayWorld({dbGlobal:'__STAY_GC_DB__',envGlobal:'__STAY_GC_ENV__',ownRoster:true});
const request=h.schedulingRequest(w,{clientRequestId:'stay:gc-probe',petIds:[h.PETS.dog],serviceCode:'boarding',careMode:'visit',preferredProviderId:'stay_host_large',scheduledStart:h.ist(3,10),scheduledEnd:h.ist(3,14)});
await h.viaWorker(w,request,async original=>{
 for(let i=0;i<8;i++){globalThis.gc();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(original.bodyUsed,false,'gateway clone collection must not consume the route body');
 const response = await scheduling.POST(original);
 assert.equal(response.status,200,await response.clone().text());
 return response;
});
assert.equal(Object.hasOwn(request,'clone'),false,'dispatch restores the native clone method');
