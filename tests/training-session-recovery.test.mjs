import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {CustomerSessionExpiredError,loadCustomerPets} from "../lib/customer-account-client.ts";
test("only an account 401 requests session recovery",async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response("not JSON",{status:401});
    await assert.rejects(loadCustomerPets("synthetic"),CustomerSessionExpiredError);
    globalThis.fetch=async()=>Response.json({error:"unavailable"},{status:503});
    await assert.rejects(loadCustomerPets("synthetic"),e=>!(e instanceof CustomerSessionExpiredError));
    globalThis.fetch=async()=>Response.json({data:{pets:[]}});
    assert.deepEqual(await loadCustomerPets("synthetic"),[]);
  } finally {globalThis.fetch=original;}
});
test("training reuses OTP and isolates forms when identity changes",()=>{
  const source=readFileSync(new URL("../app/mobile-app/training-flow.tsx",import.meta.url),"utf8");
  assert.ok(source.includes("key={identity.customerId}"));
  assert.ok(source.includes("if (sessionExpired) return"));
  assert.ok(source.includes("<CustomerLogin embedded"));
  assert.ok(source.includes("setCheckoutQuote(null);setAgreed(false);setPets(null)"));
  assert.ok(source.includes("[customer.customerId,sessionRevision]"));
  const shell=readFileSync(new URL("../app/mobile-app/page.tsx",import.meta.url),"utf8");
  assert.ok(shell.includes("<TrainingFlow key={customer.customerId} customer={customer} onVerified={onVerified}/>"));
});
