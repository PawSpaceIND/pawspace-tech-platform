import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workerSource=fs.readFileSync("worker/index.ts","utf8");

test("API pre-route inspection cannot consume the request body delivered to the route",async()=>{
  assert.match(workerSource,/const inspectionRequest=request\.clone\(\)/,
    "worker must clone once before authorization/service inspection");
  assert.match(workerSource,/authorizePlatformSessionRequest\(inspectionRequest,env\.DB\)/);
  assert.match(workerSource,/authorizeApiRequest\(inspectionRequest, env\)/);
  assert.match(workerSource,/blockDisabledServiceRequest\(inspectionRequest,env\.DB\)/);
  assert.match(workerSource,/handler\.fetch\(request, env, ctx\)/,
    "application route must receive the original request, not the inspected clone");
  assert.doesNotMatch(workerSource,/handler\.fetch\(inspectionRequest/);

  const payload={mode:"public",sessionKey:"p0-452",message:"Please call me about grooming",phone:"+919900000001"};
  const original=new Request("https://app.pawspace.in/api/ai-web-chat",{
    method:"POST",
    headers:{origin:"https://app.pawspace.in","content-type":"application/json"},
    body:JSON.stringify(payload),
  });
  const inspection=original.clone();
  assert.deepEqual(await inspection.json(),payload,"authorization clone must be readable");
  assert.deepEqual(await original.json(),payload,"route request body must remain independently readable");
});
