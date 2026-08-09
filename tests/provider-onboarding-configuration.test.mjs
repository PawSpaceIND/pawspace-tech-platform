import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const lib=fs.readFileSync(new URL("../lib/provider-onboarding-configuration.ts",import.meta.url),"utf8"),route=fs.readFileSync(new URL("../app/api/provider-onboarding-configuration/route.ts",import.meta.url),"utf8");

test("PO6 keeps package/process requirements versioned by vertical and jurisdiction",()=>{for(const token of["provider_onboarding_policy_versions","vertical_key","country_code","region_code","city_code","process_steps_json","package_config_json","verification_rules_json","verification_adapters_json","quiz_policy_json","interview_policy_json","media_requirements_json","sla_template_ref","activation_requirements_json","pricing_policy_ref","immutable_hash"])assert.match(lib,new RegExp(token));assert.match(lib,/return\{id,policyKey,version,status:\"draft\"/);assert.match(lib,/status='review'/);assert.match(lib,/status='approved'/);assert.match(lib,/status='active'/);assert.match(lib,/rollback/);});

test("PO6 resolves deterministic vertical-country-region-city precedence",()=>{assert.match(lib,/const score=/);assert.match(lib,/country_code/);assert.match(lib,/region_code/);assert.match(lib,/city_code/);assert.match(lib,/b\.score-a\.score/);assert.match(lib,/vertical_key IN \(\?, 'default'\)/);});

test("PO6 references canonical pricing instead of embedding trusted production price",()=>{assert.match(lib,/pricingPolicyRef/);assert.match(lib,/pricing_policy_ref/);assert.doesNotMatch(lib,/finalPrice|trustedPrice|productionPrice|amountPaise|amountPaisa/);});

test("PO7 provides governed locale registry, fallback and stable localized content",()=>{for(const token of["provider_onboarding_locales","fallback_locale","provider_onboarding_content_versions","content_key","locale_code","source_content_id","ai_assisted"])assert.match(lib,new RegExp(token));assert.match(lib,/visited=new Set/);assert.match(lib,/fallback_locale/);});

test("AI localization is draft-only and cannot silently become active",()=>{assert.match(lib,/ai_translation_draft_created/);assert.match(lib,/status:\"draft\"/);assert.match(lib,/Only draft content can enter review/);assert.match(lib,/Only reviewed content can be approved/);assert.match(lib,/Only approved content can be activated/);});

test("legal localization requires explicit legal-use approval",()=>{assert.match(lib,/legal_use_approved/);assert.match(lib,/Legal\/SLA localization requires explicit legal-use approval/);});

test("quiz translations preserve canonical semantics and scoring",()=>{assert.match(lib,/semantic_hash/);assert.match(lib,/scoring_hash/);assert.match(lib,/Quiz translation must preserve canonical semantics and scoring/);});

test("configuration API is admin-governed, same-origin and audited",()=>{assert.match(route,/authorize\(request,\"settings\.manage\"\)/);assert.match(route,/sameOrigin\(request\)/);assert.match(route,/securityAudit/);assert.match(route,/provider\.onboarding\.translation\.ai_draft/);});

test("engineering slice stays disconnected from production KYC, e-sign, AI and autonomous provider decisions",()=>{assert.match(lib,/productionReady:false/);assert.match(lib,/externalVerificationConnected:false/);assert.match(lib,/externalEsignConnected:false/);assert.match(lib,/externalAiTranslationRequired:false/);assert.match(lib,/autonomousProviderDecision:false/);assert.doesNotMatch(lib,/fetch\(|axios|productionReady:true|autonomousProviderDecision:true/);});
