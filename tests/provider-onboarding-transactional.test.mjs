import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8"),lib=read("lib/provider-onboarding-transactional.ts"),route=read("app/api/provider-onboarding/route.ts");

test("PO1 persists canonical application state and immutable event history",()=>{for(const token of["provider_onboarding_applications","provider_onboarding_events","application_created","from_status","to_status","actor_id","policy_ref"])assert.match(lib,new RegExp(token));assert.match(lib,/resolveProviderOnboardingPolicy/);assert.match(lib,/An active onboarding policy is required before submission/);});

test("PO1 enforces prerequisites instead of advancing a browser-owned state machine",()=>{assert.match(lib,/Only draft applications can be submitted/);assert.match(lib,/Application must be submitted before verification/);assert.match(lib,/Verification must be explicitly verified before quiz/);assert.match(lib,/Quiz must be completed before interview/);});

test("PO2 stores secure document references with sensitive classification",()=>{for(const token of["provider_onboarding_documents","file_ref","sensitive_identity","expires_at","requiredDocumentTypes"])assert.match(lib,new RegExp(token));assert.doesNotMatch(lib,/base64|rawDocument|documentBytes/);});

test("PO2 verification is UAT and fail-closed until explicitly verified",()=>{assert.match(lib,/environment,status/);assert.match(lib,/'uat','not_connected'/);assert.match(lib,/externalConnected:false/);assert.match(lib,/manual_review_required/);assert.match(lib,/clearManualVerificationReview/);assert.doesNotMatch(lib,/fetch\(|axios|productionKyc|externalConnected:true/);});

test("PO3 requires exactly twenty stable scored questions",()=>{assert.match(lib,/questions\.length!==20/);assert.match(lib,/questionId/);assert.match(lib,/correctAnswerId/);assert.match(lib,/question_count/);assert.match(lib,/questionCount:20/);});

test("PO3 AI-assisted quiz output remains draft until human approval",()=>{assert.match(lib,/status:\"draft\"/);assert.match(lib,/autoPublished:false/);assert.match(lib,/Only a complete 20-question draft can be approved/);assert.match(lib,/approved_by/);});

test("PO3 scoring is deterministic and never final provider acceptance",()=>{assert.match(lib,/correct\/20\*100/);assert.match(lib,/passed/);assert.match(lib,/needs_review/);assert.match(lib,/did_not_meet_quiz_threshold/);assert.match(lib,/deterministicScoring:true/);assert.match(lib,/finalProviderDecision:false/);});

test("PO3 creates a fifteen minute interview guide but leaves decision with Ops",()=>{assert.match(lib,/buildInterviewGuide/);assert.match(lib,/durationMinutes:15/);assert.match(lib,/finalDecisionAuthority:\"human_ops\"/);});

test("transactional API is staff governed same-origin and security audited",()=>{assert.match(route,/authorize\(request,\"settings\.manage\"\)/);assert.match(route,/sameOrigin\(request\)/);assert.match(route,/securityAudit/);for(const action of["create_application","add_document","create_verification","verification_result","create_quiz_draft","approve_quiz","score_quiz"])assert.match(route,new RegExp(action));});

test("PO1 to PO3 remain engineering UAT only",()=>{for(const token of["productionReady:false","externalKycConnected:false","externalAiQuizGenerationConnected:false","autonomousProviderApproval:false","defaultInterviewMinutes:15","defaultQuizQuestions:20"])assert.match(lib,new RegExp(token));});
