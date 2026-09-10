import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {prepareContactSubmission,submitContactEnquiry,CONTACT_SUBMISSION_STORAGE_KEY} from '../lib/contact-submission-client.ts';
const body={name:'Synthetic lead',phone:'9000000882',message:'Local-only test',service:'Dog Walking',whatsappConsent:false};
function storage(){const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};}
const ok=()=>Response.json({ok:true,leadId:'LEAD-TEST',duplicatePrevented:true});

test('same form inputs retain one opaque reference across reload-style callers',async()=>{
 const s=storage(),a=await prepareContactSubmission(body,s,webcrypto),b=await prepareContactSubmission({...body},s,webcrypto);assert.equal(a,b);const record=s.getItem(CONTACT_SUBMISSION_STORAGE_KEY);assert.ok(record.includes(a));for(const value of [body.name,body.phone,body.message])assert.equal(record.includes(value),false);assert.equal(JSON.parse(record).fingerprint.length,64);
});
for(const key of ['service','phone','whatsappConsent'])test(`editing ${key} creates a distinct deliberate submission`,async()=>{
 const s=storage(),first=await prepareContactSubmission(body,s,webcrypto);const next=await prepareContactSubmission({...body,[key]:key==='whatsappConsent'?true:'changed'},s,webcrypto);assert.notEqual(first,next);
});
test('lost response retry reuses exactly the same submitted reference',async()=>{
 const s=storage(),sent=[];let attempts=0;const fetcher=async(_url,init)=>{sent.push(JSON.parse(init.body));if(!attempts++)throw new TypeError('network failed');return ok();};await assert.rejects(()=>submitContactEnquiry(body,{storage:s,cryptoApi:webcrypto,fetcher}),/same enquiry reference/);assert.equal((await submitContactEnquiry(body,{storage:s,cryptoApi:webcrypto,fetcher})).leadId,'LEAD-TEST');assert.equal(sent[0].requestId,sent[1].requestId);
});
test('timeout keeps its retry identity',async()=>{
 const s=storage();let requestId;const fetcher=(_url,init)=>new Promise((resolve,reject)=>{requestId=JSON.parse(init.body).requestId;init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});await assert.rejects(()=>submitContactEnquiry(body,{storage:s,cryptoApi:webcrypto,fetcher,timeoutMs:5}),/timed out/);assert.equal(JSON.parse(s.getItem(CONTACT_SUBMISSION_STORAGE_KEY)).requestId,requestId);
});
for(const result of [{},{ok:true},{ok:false,leadId:'LEAD-TEST'}])test(`HTTP success cannot hide incomplete result ${JSON.stringify(result)}`,async()=>{await assert.rejects(()=>submitContactEnquiry(body,{storage:storage(),cryptoApi:webcrypto,fetcher:async()=>Response.json(result)}),/incomplete/);});
test('blocked or discarded browser storage prevents an unprotected send',async()=>{
 let sends=0;for(const s of [{getItem:()=>null,setItem:()=>{throw new Error('quota');}},{getItem:()=>null,setItem:()=>{}}]){await assert.rejects(()=>submitContactEnquiry(body,{storage:s,cryptoApi:webcrypto,fetcher:async()=>{sends++;return ok();}}),/could not be saved/);}assert.equal(sends,0);
});
test('corrupt stored metadata is reported without silently minting another request',async()=>{const s=storage();s.setItem(CONTACT_SUBMISSION_STORAGE_KEY,'{');await assert.rejects(()=>prepareContactSubmission(body,s,webcrypto),/unavailable/);});
