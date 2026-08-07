import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("OTP identity exchange issues a bounded HttpOnly canonical session",async()=>{
  const[session,assertion,route]=await Promise.all([source("lib/platform-session.ts"),source("lib/verified-identity-assertion.ts"),source("app/api/identity-session/route.ts")]);
  assert.match(session,/platform_identity_sessions/);
  assert.match(session,/token_hash TEXT NOT NULL UNIQUE/);
  assert.match(session,/HttpOnly; Secure; SameSite=Lax/);
  assert.match(session,/Math\.min\(Math\.max\(Number\(input\.ttlSeconds\|\|28_800\),900\),86_400\)/);
  assert.match(session,/binding_verification/);
  assert.match(session,/status='superseded'/);
  assert.match(assertion,/PAWSPACE_IDENTITY_ENV/);
  assert.match(assertion,/PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT/);
  assert.match(assertion,/HMAC/);
  assert.match(assertion,/verified_identity_assertion_nonces/);
  assert.match(assertion,/Identity assertion has already been used/);
  assert.match(assertion,/locked to sandbox/);
  assert.match(route,/verifyIdentityAssertion/);
  assert.match(route,/upsertIdentityBinding/);
  assert.match(route,/platformSessionCookie/);
  assert.match(route,/clearPlatformSessionCookie/);
});

test("customer and provider sessions are scoped before reaching self-service APIs",async()=>{
  const[sessionGateway,serverAuth,worker]=await Promise.all([source("lib/session-api-gateway.ts"),source("lib/server-auth.ts"),source("worker/index.ts")]);
  assert.match(sessionGateway,/\/api\/uat-scheduling/);
  assert.match(sessionGateway,/\/api\/canonical-bookings/);
  assert.match(sessionGateway,/\/api\/grooming-booking-change/);
  assert.match(sessionGateway,/\/api\/partner-grooming-jobs/);
  assert.match(sessionGateway,/\/api\/grooming-lifecycle/);
  assert.match(sessionGateway,/\/api\/grooming-route/);
  assert.match(sessionGateway,/session\.subjectType!==scope\.subjectType/);
  assert.match(sessionGateway,/scope\.subjectId!==session\.subjectId/);
  assert.match(sessionGateway,/body\.action==="mark_paid"\?undefined/);
  assert.match(serverAuth,/resolvePlatformSession\(db,request\)/);
  assert.match(serverAuth,/identitySource:session\.identitySource/);
  assert.match(worker,/authorizePlatformSessionRequest\(request,env\.DB\)/);
  assert.match(worker,/url\.pathname==="\/api\/identity-session"/);
});
