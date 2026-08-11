import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("canonical Partner root routes onboarding to server-owned provider flow",async()=>{
  const page=await source("app/partner/page.tsx");
  assert.match(page,/\/partner\/onboarding/);
  assert.match(page,/PRODUCTION READY = FALSE/);
  assert.match(page,/Marketplace live: No/);
  assert.match(page,/Order eligible: No/);
  assert.doesNotMatch(page,/Ready to take bookings|Partner activated|Police verification.*Approved|Digitally signed|Live & available/);
});

test("canonical Partner jobs derive provider identity from the verified session",async()=>{
  const jobs=await source("app/partner-app/canonical-grooming-jobs.tsx");
  assert.match(jobs,/\/api\/identity-session/);
  assert.match(jobs,/subjectType!=="provider"/);
  assert.match(jobs,/body\.data\.subjectId/);
  assert.match(jobs,/encodeURIComponent\(providerId\)/);
  assert.doesNotMatch(jobs,/providerId=groom_arun/);
});

test("Partner mobile app declares itself as the real, identity-verified UAT surface",async()=>{
  const layout=await source("app/partner-app/layout.tsx");
  assert.match(layout,/PARTNER MOBILE UAT/);
  assert.match(layout,/Verified provider identity/);
  assert.match(layout,/Live payouts, background GPS and production activation remain disabled/);
});
