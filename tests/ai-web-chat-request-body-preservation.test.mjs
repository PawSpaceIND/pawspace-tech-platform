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
  const inspection=original.clone();
  assert.deepEqual(await inspection.json(),payload,"an independent inspection request must be readable");
  assert.deepEqual(await original.json(),payload,"route request body must remain independently readable");
});

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
