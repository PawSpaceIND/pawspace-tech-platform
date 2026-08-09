import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8"),lib=read("lib/provider-onboarding-self-service.ts"),route=read("app/api/provider-onboarding-self-service/route.ts"),sessionGateway=read("lib/session-api-gateway.ts"),page=read("app/partner/onboarding/page.tsx");

test("provider onboarding self service is platform-session scoped",()=>{assert.match(route,/resolvePlatformSession/);assert.match(route,/actor\.subjectType!==\"provider\"/);assert.match(route,/actor\.roleCode!==\"service_provider\"/);assert.match(sessionGateway,/provider-onboarding-self-service/);assert.match(sessionGateway,/permission:\"bookings\.view\",subjectType:\"provider\"/);});

test("provider application ownership is server authoritative",()=>{assert.match(lib,/WHERE id=\?/);assert.match(lib,/Provider onboarding ownership denied/);assert.match(lib,/payload=\{\.\.\.input\.payload,providerId:input\.providerId\}/);assert.doesNotMatch(route,/providerId\?:/);});

test("provider cannot choose a different quiz version",()=>{assert.match(lib,/quiz_version_ref/);assert.match(lib,/Quiz version does not match the application qualification policy/);assert.match(lib,/quizVersionId:frozenQuiz/);});

test("self service snapshot minimizes sensitive data",()=>{assert.match(lib,/WHERE provider_id=\?/);assert.doesNotMatch(lib,/SELECT id,document_type,file_ref/);assert.doesNotMatch(lib,/SELECT id,media_type,file_ref/);assert.doesNotMatch(lib,/actor_id,created_at FROM provider_onboarding_events/);assert.match(lib,/sanitizeQuestions/);assert.doesNotMatch(lib,/correctAnswerId:text/);});

test("provider self service exposes only provider-owned actions",()=>{for(const action of["create_application","add_document","submit_application","score_quiz","accept_sla_uat","save_profile","add_profile_media","update_activated_profile"])assert.match(route,new RegExp(action));for(const forbidden of["verification_result","clear_manual_verification","record_human_decision","complete_interview","schedule_interview","activate_provider_uat","evaluate_activation","create_sla"])assert.doesNotMatch(route,new RegExp(`action===\\\"${forbidden}\\\"`));});

test("SLA acceptance identity is derived from provider session",()=>{assert.match(lib,/acceptedBy:input\.providerId/);assert.doesNotMatch(route,/acceptedBy\?:string/);});

test("partner onboarding page uses canonical self service without fake activation",()=>{assert.match(page,/\/api\/identity-session/);assert.match(page,/\/api\/provider-onboarding-self-service/);assert.match(page,/20-question qualification/);assert.match(page,/15-minute Ops interview/);assert.match(page,/PRODUCTION READY = FALSE/);assert.match(page,/Marketplace live: <b>No<\/b>/);assert.match(page,/Provider self-service cannot activate itself/);assert.doesNotMatch(page,/<b>\s*100%\s*<\/b>|Ready to take bookings|Partner activated|Digitally signed|Police verification.*Approved/);});

test("production and autonomous boundaries remain false",()=>{for(const token of["productionReady:false","externalKycConnected:false","externalEsignConnected:false","marketplaceLive:false","orderEligible:false","autonomousProviderDecision:false"])assert.match(lib,new RegExp(token));assert.doesNotMatch(lib,/marketplaceLive:true|orderEligible:true/);});
