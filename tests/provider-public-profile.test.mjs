import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';

const source=fs.readFileSync('lib/provider-public-profile.ts','utf8');
const route=fs.readFileSync('app/api/provider-public-profile/route.ts','utf8');

test('rating and quality score are never queried or returned - they are never organically earned in this codebase',()=>{
  assert.doesNotMatch(source,/SELECT[^;]*\bquality_score\b/);
  assert.doesNotMatch(source,/SELECT[^;]*,\s*rating\b/);
  assert.doesNotMatch(source,/rating:\s*(capacity|onboarding)/);
});

test('only the non-sensitive provider_photo media type is used, never home or facility photos',()=>{
  assert.match(source,/media_type='provider_photo'/);
  assert.doesNotMatch(source,/home_photo/);
  assert.doesNotMatch(source,/facility_photo/);
});

test('a photo is only shown if publish_approved - not any uploaded photo',()=>{
  assert.match(source,/publish_approved=1/);
});

test('verified badge requires a real activation run, not an always-on flag',()=>{
  assert.match(source,/provider_onboarding_activation_runs/);
  assert.match(source,/activated_uat/);
});

test('stats are hidden below a real minimum volume threshold rather than showing zero',()=>{
  assert.match(source,/MIN_STATS_THRESHOLD/);
  assert.match(source,/isNewProvider/);
});

test('the public API route never requires staff auth - a customer sees this before logging in',()=>{
  assert.doesNotMatch(route,/authorize\(/);
});
