import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { requestForAuthorization } from "../lib/trusted-workspace-identity.ts";

const workerSource=fs.readFileSync("worker/index.ts","utf8");

test("API pre-route inspection cannot consume the request body delivered to the route",async()=>{
  assert.match(workerSource,/const inspectionRequest=requestForAuthorization\(request,/,
    "worker must derive a sanitized authorization request before gateway inspection");
  assert.match(workerSource,/authorizePlatformSessionRequest\(inspectionRequest,env\.DB\)/);
  assert.match(workerSource,/authorizeApiRequest\(inspectionRequest, env\)/);
  assert.match(workerSource,/blockDisabledServiceRequest\(inspectionRequest,env\.DB\)/);
  assert.match(workerSource,/handler\.fetch\(request, env, ctx\)/,
    "application route must receive the original request, not the inspected/sanitized request");
  assert.doesNotMatch(workerSource,/handler\.fetch\(inspectionRequest/);

  const payload={mode:"public",sessionKey:"p0-452",message:"Please call me about grooming",phone:"+919900000001"};
  const original=new Request("https://app.pawspace.in/api/ai-web-chat",{
    method:"POST",
    headers:{origin:"https://app.pawspace.in","content-type":"application/json"},
    body:JSON.stringify(payload),
  });
  const {requestForAuthorization}=await import("../lib/trusted-workspace-identity.ts");
  const inspection=requestForAuthorization(original,{PAWSPACE_DEPLOYMENT_ENV:"e2e"});
  assert.equal(original.bodyUsed,false);
  assert.equal(original.body.locked,false);
  assert.deepEqual(await inspection.json(),payload,"an independent inspection request must be readable");
  assert.deepEqual(await original.json(),payload,"route request body must remain independently readable");
});

for(const deployment of ["e2e","uat","production"]){
 test(`untrusted ${deployment} POST sanitization preserves OTP route body and session headers`,async()=>{
  const {requestForAuthorization}=await import("../lib/trusted-workspace-identity.ts");
  const payload={action:"request",phone:"+919900000001"};
  const original=new Request("https://app.pawspace.in/api/customer-otp",{method:"POST",headers:{
   "content-type":"application/json",origin:"https://app.pawspace.in",cookie:"customer_session=test-only",
   "oai-authenticated-user-email":"spoofed@pawspace.in","oai-authenticated-user-full-name":"Spoofed",
   "oai-authenticated-user-full-name-encoding":"percent-encoded-utf-8"
  },body:JSON.stringify(payload)});
  const inspection=requestForAuthorization(original,{PAWSPACE_DEPLOYMENT_ENV:deployment});
  for(const header of ["oai-authenticated-user-email","oai-authenticated-user-full-name","oai-authenticated-user-full-name-encoding"]){
   assert.equal(inspection.headers.get(header),null);
  }
  assert.equal(inspection.headers.get("cookie"),"customer_session=test-only");
  assert.equal(inspection.headers.get("origin"),"https://app.pawspace.in");
  assert.deepEqual(await inspection.clone().json(),payload);
  assert.equal(original.bodyUsed,false);
  assert.equal(original.body.locked,false);
  // The router reconstructs the request with middleware headers before invoking the OTP handler.
  const routed=new Request(original,{headers:new Headers(original.headers)});
  assert.deepEqual(await routed.json(),payload);
  assert.deepEqual(await inspection.json(),payload);
 });
}

test("direct Worker authorization strips spoofed identity without transferring the route body", async () => {
  for (const path of ['/api/customer-otp', '/api/staging-login', '/api/canonical-bookings']) {
    const payload = { action: 'request', fixture: 'synthetic-body-preservation' };
    const original = new Request(`https://pawspace-staging.example.workers.dev${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'spoof@example.test', cookie: 'session=test-fixture' },
      body: JSON.stringify(payload),
    });
    const inspection = requestForAuthorization(original, { PAWSPACE_DEPLOYMENT_ENV: 'staging' });
    assert.equal(inspection.headers.get('oai-authenticated-user-email'), null);
    assert.equal(inspection.headers.get('cookie'), 'session=test-fixture');
    assert.equal(original.bodyUsed, false, 'creating the inspection must not disturb the original stream');
    assert.deepEqual(await inspection.clone().json(), payload);
    assert.deepEqual(await original.json(), payload, 'the app handler still receives its full body');
  }
});
