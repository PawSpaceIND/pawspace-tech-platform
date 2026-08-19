import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const training = fs.readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
const partner = fs.readFileSync(new URL("../app/partner-mobile/page.tsx", import.meta.url), "utf8");

test("UAT closure: package flow does not offer fake per-session scheduling", () => {
  assert.doesNotMatch(training, /Choose each session myself/);
  assert.doesNotMatch(training, /cadenceDays\s*:\s*frequency===/);
});

test("UAT closure: Meet & Greet is not rendered as a post-package upsell", () => {
  assert.doesNotMatch(training, /NOT READY TO BUY A PACKAGE\?/);
  assert.doesNotMatch(training, /Meet the trainer first\. Book only when you feel confident\./);
});

test("UAT closure: partner mobile is identity-driven, not hard-coded to Arjun Kumar", () => {
  assert.doesNotMatch(partner, />Arjun Kumar</);
  assert.match(partner, /identity-session/);
});

test("UAT closure: partner UAT exposes an explicit governed identity-switch path", () => {
  assert.match(partner, /staging-login|uat.*identity|switch.*provider|provider.*switch/i);
});

test("UAT closure: trainer discovery remains backed by the canonical roster", () => {
  assert.match(training, /loadTrainingTrainers/);
  assert.match(training, /Your trainer matches|No eligible trainer/i);
});

test("UAT closure: Meet & Greet uses the same governed quote/reserve/canonical lifecycle", () => {
  assert.match(training, /quoteTraining\(\{packageCode:"trainer-meet-greet"/);
  assert.match(training, /reserveUatSchedule/);
  assert.match(training, /createCanonicalLifecycle/);
});

const providerSwitch=fs.readFileSync(new URL("../app/api/uat-provider-switch/route.ts",import.meta.url),"utf8");
const gateway=fs.readFileSync(new URL("../lib/api-gateway.ts",import.meta.url),"utf8");
test("UAT provider switch route is production-dead and access-code governed",()=>{assert.match(providerSwitch,/uatLoginEnabled/);assert.match(providerSwitch,/uatAccessCodeValid/);assert.match(providerSwitch,/issuePlatformSession/);assert.match(gateway,/\/api\/uat-provider-switch/);});
