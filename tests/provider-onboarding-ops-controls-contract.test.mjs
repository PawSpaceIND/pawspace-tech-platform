import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8"),ops=read("app/team/provider-onboarding/page.tsx"),control=read("app/control/provider-onboarding/page.tsx");

test("provider Ops page declares the human-controlled lifecycle actions",()=>{for(const token of["create_verification","verification_result","clear_manual_verification","schedule_interview","complete_interview","record_human_decision","create_sla","activate_provider_uat"])assert.match(ops,new RegExp(token));assert.match(ops,/AI cannot approve or reject/);});

test("provider Ops activation remains UAT-only",()=>{assert.match(ops,/PRODUCTION READY = FALSE/);assert.match(ops,/Marketplace live:<\/strong> No/);assert.match(ops,/Order eligible:<\/strong> No/);assert.match(ops,/live:<\/strong> 0/);assert.doesNotMatch(ops,/productionReady.?=.?true|marketplaceLive.?=.?true|orderEligible.?=.?true/);});

test("provider configuration page declares the governed lifecycle transitions",()=>{for(const token of["save_locale","create_policy_draft","create_content_draft","transition_policy","transition_content","submit_review","approve","activate"])assert.match(control,new RegExp(token));assert.match(control,/defaultQuestionCount:20/);assert.match(control,/durationMinutes:15/);assert.match(control,/legalUseApproved/);});

test("configuration page keeps production boundary closed",()=>{assert.match(control,/PRODUCTION READY = FALSE/);assert.match(control,/not_connected/);assert.doesNotMatch(control,/PRODUCTION READY = TRUE|productionReady.?=.?true/);});
