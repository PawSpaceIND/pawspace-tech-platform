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

// SOURCE CONTRACT, NOT EXECUTION PROOF. The wiring below is correct in production -
// canonical-grooming-jobs.tsx fetches /api/identity-session, refuses a subjectType other than
// "provider" or a missing subjectId, resolves to body.data.subjectId, and interpolates only
// encodeURIComponent(providerId) into the jobs request. But that data flow lives in two useEffect
// hooks inside a "use client" component, so proving it by execution needs a DOM, a React renderer and
// effect flushing - none of which this repository has (no jsdom, no @testing-library, and no test
// renders a component). Adding them is a separate piece of work, owned by the Partner surface lane.
// So these four assertions are independent source regexes and the name says so. The last one is the
// non-vacuity guard: a hard-coded provider id would fail it.
test("canonical Partner jobs declare verified-session provider identity wiring",async()=>{
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
