import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('Training has a permanent UAT closure contract',async()=>{const[p,t]=await Promise.all([read('docs/TRAINING_CLOSURE_PLAN.md'),read('tests/training-closure.test.mjs')]);assert.match(p,/PRODUCTION READY = FALSE/);assert.match(p,/canonical programme/);assert.match(t,/Training API permissions are explicit/);});

test('Customer 360 joins canonical customers pets bookings CX consent and duplicate review',async()=>{const[g,a]=await Promise.all([read('lib/customer-360.ts'),read('app/api/customer-360/route.ts')]);for(const token of ['canonical_customers','canonical_pets','canonical_bookings','customer_experience_tickets','customer_contact_preferences','customer_merge_reviews'])assert.ok(g.includes(token),token);assert.match(a,/customers\.view/);assert.match(a,/customers\.manage/);assert.match(a,/no destructive merge is executed/);});

test('Revenue intelligence uses canonical signals and never invents contribution margin',async()=>{const r=await read('lib/revenue-intelligence.ts');for(const token of ['recencyDays','frequency','monetaryValue','serviceGaps','unresolved_refund_or_payment_issue','open_complaint_or_safety_issue','marketing_consent_missing'])assert.ok(r.includes(token),token);assert.match(r,/expectedMargin:null/);assert.match(r,/marginStatus:"configuration_required"/);assert.doesNotMatch(r,/0\.42/);assert.match(r,/estimateOnly:true/);});

test('CRM automation is policy gated idempotent retry bounded and dead lettered',async()=>{const g=await read('lib/crm-automation-governance.ts');for(const token of ['automation_policy_not_approved','quiet_hours','frequency_cap','idempotency_key','duplicatePrevented','retry_policy_not_configured','retry_exhausted','crm_automation_dead_letters'])assert.ok(g.includes(token),token);assert.match(g,/VALUES \(\?,\?,\?,\?,\?,'queued',0,\?,\?,\?,\?\)/);});

test('Unified conversations preserve thread links assignment SLA and visibility boundary',async()=>{const[g,a,p]=await Promise.all([read('lib/conversation-governance.ts'),read('app/api/conversations/route.ts'),read('app/team/customer-experience/page.tsx')]);for(const token of ['communication_threads','communication_participants','communication_messages','conversation_assignments','conversation_audit_events'])assert.ok(g.includes(token),token);assert.match(g,/scope!=="staff"/);assert.match(a,/communications\.message/);assert.match(p,/Unified conversation & CX queue/);});

test('Partner Finance is policy gated and sandbox only',async()=>{const[g,a,p]=await Promise.all([read('lib/partner-settlement-governance.ts'),read('app/api/partner-finance/route.ts'),read('app/team/finance/partners/page.tsx')]);assert.match(g,/policy_status TEXT NOT NULL DEFAULT 'configuration_required'/);assert.match(g,/environment TEXT NOT NULL DEFAULT 'sandbox'/);assert.match(g,/Partner payout policy is not approved\/configured/);assert.match(a,/livePayouts:false/);assert.match(p,/No RazorpayX\/production payout/);});

test('Marketing starts draft and requires approval plus governed audience snapshot',async()=>{const[g,a,p]=await Promise.all([read('lib/marketing-governance.ts'),read('app/api/marketing-control/route.ts'),read('app/team/marketing/page.tsx')]);for(const token of ['marketing_consent_missing','open_customer_experience_case','duplicate_review_required','data_quality_low','holdout'])assert.ok(g.includes(token),token);assert.match(g,/approval_required/);assert.match(g,/requires explicit approval before activation/);assert.match(a,/liveMediaSpend:false/);assert.doesNotMatch(a,/seedCampaigns|seedRules|roasBelow/);assert.match(p,/Governed campaign command centre/);});

test('Company analytics is canonical and marks unavailable metrics explicitly',async()=>{const[g,a,p]=await Promise.all([read('lib/company-analytics.ts'),read('app/api/company-analytics/route.ts'),read('app/team/analytics/page.tsx')]);for(const token of ['canonical_bookings','booking_payments','customer_experience_tickets','provider_capacity_profiles'])assert.ok(g.includes(token),token);assert.match(g,/contributionMarginStatus:"configuration_required"/);assert.match(g,/marketingSpend:"not_connected"/);assert.match(a,/staticOperationalCounters:false/);assert.match(p,/No static operational counters/);});

test('AI remains review-only and blocks sensitive autonomous actions',async()=>{const[g,a,p]=await Promise.all([read('lib/ai-governance.ts'),read('app/api/ai-intelligence/route.ts'),read('app/team/ai/page.tsx')]);for(const token of ['refund','price_change','payment','payout','outbound_contact','customer_merge','provider_assignment','campaign_activation'])assert.ok(g.includes(token),token);assert.match(g,/review_required/);assert.match(g,/minimum_necessary/);/* This used to pin the literal `providerStatus:"not_connected"`, which is how the route came to keep
   reporting a disconnected provider after one was configured: the assertion protected the constant
   rather than the property. The property is that the status is DERIVED and that configuration is never
   presented as verification. */
 assert.match(a,/aiProviderConnection\(\)/);
 assert.doesNotMatch(a,/providerStatus:"not_connected"/);
 assert.match(a,/providerVerified:connection\.verified/);assert.match(a,/autonomousExecution:false/);assert.match(p,/Autonomous execution/);});

test('Team Sales reads canonical Customer 360 and governed revenue intelligence',async()=>{const p=await read('app/team/sales/page.tsx');assert.match(p,/\/api\/customer-360/);assert.match(p,/\/api\/revenue-intelligence/);assert.match(p,/Canonical Customer 360 & Revenue worklist/);});

test('API gateway explicitly maps all platform closure routes',async()=>{const g=await read('lib/api-gateway.ts');for(const route of ['/api/customer-360','/api/revenue-intelligence','/api/crm-automation','/api/conversations','/api/partner-finance','/api/company-analytics','/api/ai-intelligence'])assert.ok(g.includes(route),`${route} must be explicit`);assert.match(g,/body\.action==="save_policy"\?"settings\.manage":"customers\.manage"/);});

test('Platform pre-live closure never claims production readiness',async()=>{const p=await read('docs/PLATFORM_PRELIVE_CLOSURE.md');assert.match(p,/PRODUCTION READY = FALSE/);for(const token of ['live payments','live payouts','live communications','production storage','marketing media spend','AI model provider','real-device'])assert.ok(p.toLowerCase().includes(token.toLowerCase()),token);});
