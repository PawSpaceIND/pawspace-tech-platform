import test from "node:test";
import assert from "node:assert/strict";
import {probeExotelRegion} from "../scripts/exotel-region-probe.mjs";

const response=status=>new Response("secret provider body that must be discarded",{status});
test("read-only probe selects exactly one authenticated Exotel region and never POSTs",async()=>{
  const calls=[];
  const result=await probeExotelRegion({key:"key",token:"token",sid:"sid",fetcher:async(url,init)=>{calls.push({url:String(url),method:init.method,authorization:new Headers(init.headers).get("authorization")});return response(String(url).includes("api.in.exotel.com")?200:401);}});
  assert.equal(result.host,"api.in.exotel.com");
  assert.deepEqual(result.statuses,[{host:"api.exotel.com",status:401},{host:"api.in.exotel.com",status:200}]);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.method==="GET"));assert.ok(calls.every(call=>call.url.includes("/Calls.json?PageSize=1")));
  assert.ok(calls.every(call=>call.authorization==="Basic a2V5OnRva2Vu"));
});

test("probe fails closed if both regions authenticate",async()=>{
  await assert.rejects(()=>probeExotelRegion({key:"k",token:"t",sid:"s",fetcher:async()=>response(200)}),/ambiguous/);
});
test("probe fails closed if neither region authenticates and reports statuses only",async()=>{
  await assert.rejects(()=>probeExotelRegion({key:"k",token:"t",sid:"s",fetcher:async(url)=>response(String(url).includes("api.in")?404:401)}),/statuses api\.exotel\.com:401,api\.in\.exotel\.com:404/);
});
test("probe requires complete credentials before any network call",async()=>{
  let calls=0;await assert.rejects(()=>probeExotelRegion({key:"",token:"t",sid:"s",fetcher:async()=>{calls++;return response(200)}}),/requires API key/);assert.equal(calls,0);
});
test("caller-ID history check reads only Metadata.Total and never emits call details",async()=>{
  const calls=[];
  const result=await probeExotelRegion({key:"key",token:"token",sid:"sid",callerId:"08012345678",fetcher:async(url,init)=>{
    calls.push(String(url));
    if(String(url).includes("api.in.exotel.com"))return response(401);
    if(String(url).includes("PhoneNumber="))return Response.json({Metadata:{Total:7},Calls:[{To:"secret-customer",From:"secret-agent"}]});
    return response(200);
  }});
  assert.equal(result.host,"api.exotel.com");assert.equal(result.callerIdHistoryMatch,true);assert.equal(result.callerIdHistoryCount,7);
  assert.equal(calls.length,3);assert.ok(calls[2].includes("PhoneNumber=08012345678"));
});
