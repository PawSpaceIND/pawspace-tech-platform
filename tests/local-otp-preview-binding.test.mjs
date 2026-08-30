import test from "node:test";
import assert from "node:assert/strict";
import { developmentOtpSandboxEnabled, resolveOtpAssertionSecret } from "../lib/otp-sandbox-runtime.ts";

test("local Worker preview binding enables OTP sandbox without relying on process NODE_ENV",()=>{
  const previous=process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try{
    const runtime={PAWSPACE_LOCAL_PREVIEW:"on",PAWSPACE_IDENTITY_ENV:"sandbox"};
    assert.equal(developmentOtpSandboxEnabled(new Request("http://localhost:5173/api/customer-otp"),runtime),true);
    assert.ok(resolveOtpAssertionSecret(runtime).length>=32);
    assert.equal(developmentOtpSandboxEnabled(new Request("https://app.pawspace.in/api/customer-otp"),runtime),false);
    assert.equal(developmentOtpSandboxEnabled(new Request("http://localhost:5173/api/customer-otp"),{...runtime,PAWSPACE_IDENTITY_ENV:"live"}),false);
    assert.equal(resolveOtpAssertionSecret({...runtime,PAWSPACE_IDENTITY_ENV:"live"}),"");
  }finally{
    if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;
  }
});
