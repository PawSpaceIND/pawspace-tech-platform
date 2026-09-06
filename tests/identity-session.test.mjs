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
  assert.match(assertion,/resolveOtpAssertionSecret/);
  assert.match(assertion,/productionOtpEnabled/);
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
  assert.match(worker,/const inspectionRequest=request\.clone\(\)/);
  assert.match(worker,/authorizePlatformSessionRequest\(inspectionRequest,env\.DB\)/);
  assert.match(worker,/url\.pathname==="\/api\/identity-session"/);
});

test("the central API gateway honours authenticated sessions and only accepts forwarded staff identity for provisioned users",async()=>{
  const gateway=await source("lib/api-gateway.ts");
  assert.match(gateway,/import \{ resolvePlatformSession \} from "\.\/platform-session"/);
  const authorize=gateway.slice(gateway.indexOf("export async function authorizeApiRequest"));
  assert.match(authorize,/resolveUatStaffActor\(env\.DB,request,env as unknown as Record<string,unknown>\)/);
  assert.match(authorize,/resolvePlatformSession\(env\.DB,request\)/);
  assert.match(authorize,/oai-authenticated-user-email/);
  assert.match(authorize,/SELECT name,role_code,status FROM app_users WHERE email=\?/);
  assert.doesNotMatch(authorize,/if\s*\(\s*!user[\s\S]{0,500}INSERT INTO app_users/);
  assert.doesNotMatch(authorize,/FOUNDER_EMAIL/);
  assert.match(authorize,/session\.permissions,permission/);
});
