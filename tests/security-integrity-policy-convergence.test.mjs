import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gateway=fs.readFileSync("lib/api-gateway.ts","utf8");
const sessionGateway=fs.readFileSync("lib/session-api-gateway.ts","utf8");
const trainingRequirements=fs.readFileSync("app/api/training-requirements/route.ts","utf8");
const hostTrust=fs.readFileSync("app/api/host-trust/route.ts","utf8");
const providerAvailability=fs.readFileSync("app/api/provider-availability/route.ts","utf8");

test("platform-session authorization derives classified permissions from the gateway decision",()=>{
  assert.match(gateway,/export async function requiredPermission\(request:Request\)/);
  assert.match(sessionGateway,/import\{requiredPermission\}from"\.\/api-gateway"/);
  assert.match(sessionGateway,/await requiredPermission\(request\)/);
  assert.doesNotMatch(sessionGateway,/permission:"(?:bookings|scheduling|pricing|providers|dashboard)\./);
  // Provider onboarding already enforced a provider identity session before this convergence pass.
  // Preserve that established bookings.view contract until the global registry line is migrated too.
  assert.match(sessionGateway,/provider-onboarding-self-service"\?"bookings\.view":await requiredPermission/);
});

test("approved public-read/write policies are explicit",()=>{
  assert.match(gateway,/url\.pathname==="\/api\/training-requirements"\)return method==="GET"\?null:"pricing\.manage"/);
  assert.match(gateway,/url\.pathname==="\/api\/host-trust"/);
  assert.match(gateway,/body\.action==="seed"\?"providers\.manage":"scheduling\.book"/);
  assert.match(trainingRequirements,/authorize\(request, "pricing\.manage"\)/);
  assert.match(hostTrust,/authorize\(request,"providers\.manage"\)/);
  assert.match(hostTrust,/requireCustomerOwnership\(db,actor,input\.customerId\)/);
});

test("canonical read and provider availability use the approved policy",()=>{
  assert.match(gateway,/url\.pathname==="\/api\/canonical-bookings"\)return method==="GET"\?"bookings\.view":"scheduling\.book"/);
  assert.match(gateway,/url\.pathname==="\/api\/provider-availability"\)return "bookings\.view"/);
  assert.match(sessionGateway,/url\.pathname==="\/api\/provider-availability"&&method==="POST"/);
  assert.match(sessionGateway,/subjectType:"provider",subjectId:String\(body\.providerId\|\|""\)/);
  assert.match(providerAvailability,/requireProviderOwnership\(db,actor,providerId\)/);
});
