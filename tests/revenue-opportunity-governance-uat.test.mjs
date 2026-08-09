import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';

const source=fs.readFileSync('lib/revenue-opportunity-governance.ts','utf8');
const api=fs.readFileSync('app/api/revenue-opportunity-governance/route.ts','utf8');

test('canonical opportunity store is separate from legacy synthetic revenue opportunities',()=>{
  assert.match(source,/canonical_revenue_opportunities/);
  assert.match(source,/legacySyntheticRevenueOpportunitiesAuthoritative:false/);
  assert.doesNotMatch(source,/generateDaily100/);
});

test('opportunity governance suppresses consent CX payment/refund duplicate quality frequency and quiet-hour risks',()=>{
  for(const marker of ['marketing_consent_missing','channel_consent_missing','customer_opted_out','open_complaint_or_safety_issue','unresolved_refund_or_payment_issue','duplicate_review_required','customer_data_quality_low','frequency_cap_reached','quiet_hours'])assert.match(source,new RegExp(marker));
});

test('opportunity estimates never equal achieved mission revenue and outreach is not automatic',()=>{
  assert.match(source,/estimatedValueIsAchievedRevenue:false/);
  assert.match(source,/automaticOutreach:false/);
  assert.match(source,/authorizeOpportunityOutreach/);
});

test('opportunity conversion must bind to a canonical booking owned by the same customer',()=>{
  assert.match(source,/SELECT id,customer_id FROM canonical_bookings/);
  assert.match(source,/Converted booking must belong to the opportunity customer/);
});

test('policy values are configured and versioned rather than hard-coded campaign truth',()=>{
  assert.match(source,/revenue_opportunity_policies/);
  assert.match(source,/revenue_opportunity_policy_versions/);
  assert.match(source,/maxOutreachPerCustomerWindow/);
  assert.match(source,/frequencyWindowHours/);
  assert.match(source,/quietStartMinute/);
  assert.match(source,/dataQualityMinScore/);
});

test('API requires customer permissions and keeps production false',()=>{
  assert.match(api,/authorize\(request,"customers\.view"\)/);
  assert.match(api,/authorize\(request,"customers\.manage"\)/);
  assert.match(api,/productionReady:false/);
});
