import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Static contract for the post-service feedback slice. These are text checks, so they catch only what
// text can catch: a fallback URL creeping back in, reward wording next to a public review link, a
// telephony import appearing in the contract, or an owner file being touched. The executed behaviour
// lives in tests/post-service-feedback-call.test.mjs.
// ---------------------------------------------------------------------------

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lib = read("lib/post-service-feedback-call.ts");
const route = read("app/api/post-service-feedback/route.ts");
const ui = read("app/mobile-app/post-service-review-invitation.tsx");
const mount = read("app/mobile-app/booking-service-feedback.tsx");

test("the contract offers no invented or fallback review URL", () => {
  assert.doesNotMatch(lib, /DEFAULT_GOOGLE_REVIEW_LINK|DEFAULT_APP_REVIEW_LINK|DEFAULT_PUBLIC_REVIEW_DESTINATION/, "no fallback link constants");
  assert.doesNotMatch(lib, /https?:\/\//, "no URL literal of any kind in the contract");
  assert.doesNotMatch(route, /https?:\/\//);
  assert.doesNotMatch(ui, /https?:\/\//, "the UI renders only URLs the API returned");
  assert.match(lib, /getActiveReviewConfig/, "links come from the approved review configuration");
  assert.match(lib, /protocol === "https:"/, "only https links qualify");
});

test("the public review invitation is never rewarded, rating-gated, or presented as verified", () => {
  assert.doesNotMatch(lib, /stars|service_reviews|review_reward_codes|feedbackReward|redeemReviewReward|claimPublicReview/, "the contract never reads the rating or touches the private reward");
  assert.match(lib, /rewarded: false; ratingGated: false; postingVerified: false; honestOnly: true/, "the terms are typed as literals");
  assert.doesNotMatch(ui, /reward|coupon|discount|cashback|voucher|free |earn|bonus|incentive/i, "no reward wording anywhere near the invitation or the call offer");
  assert.match(ui, /entirely optional/);
  assert.match(ui, /does not check whether you post/);
  assert.match(ui, /honestly experienced, whatever it was/, "honest reviews of any kind, not only happy ones");
  assert.doesNotMatch(ui, /action:\s*"claim"/, "the UI never records that a review was posted");
});

test("the contract has no telephony entry point and places calls only through an injected test-only placer", () => {
  assert.doesNotMatch(lib, /voice-outbound-canonical|voice-telephony-provider|requestOutboundVoiceCall|selectTelephonyProvider|exotel|elevenlabs/i, "no dial entry point is imported");
  assert.match(lib, /import \{ voiceUseCase \} from "\.\/voice-outbound-governance"/, "only the use-case catalogue is read for the attempt ceiling");
  assert.doesNotMatch(lib, /INSERT INTO voice_call_consents|INSERT INTO voice_call_opt_outs|recordVoiceConsent|recordVoiceOptOut|INSERT INTO communication_consent/, "consent tables are read, never written");
  assert.match(lib, /testOnly: true;/, "the placer type requires the literal");
  assert.match(lib, /placer\.testOnly !== true/, "and the sweep checks it at run time");
  assert.match(lib, /call_placer_not_injected/, "no placer means refuse");
  assert.doesNotMatch(lib, /input\.placer\s*(\?\?|\|\|)|placer\s*=\s*[^;\n]*(\?\?|\|\|)/, "no default placer expression");
  const sweep = lib.slice(lib.indexOf("export async function runPostServiceFeedbackCallSweep"));
  assert.doesNotMatch(sweep, /syntheticFeedbackCallPlacer\(/, "the sweep never constructs a placer of its own");
  assert.match(lib, /production_call_reported/, "a production call reported through the placer halts the sweep");
});

test("the route wires only the synthetic no-dial placer, behind a default-off non-production gate", () => {
  assert.doesNotMatch(route, /voice-outbound|telephony|requestOutboundVoiceCall/i);
  assert.match(route, /syntheticFeedbackCallPlacer\("route_synthetic_no_dial"\)/, "the only placer the route ever constructs");
  assert.equal((route.match(/syntheticFeedbackCallPlacer\(/g) || []).length, 1, "exactly one placer construction in the route");
  assert.equal((route.match(/placer:\s*synthetic/g) || []).length, 1, "exactly one placer injection in the route");
  assert.match(route, /syntheticDispatchPermitted\(env\)/, "dispatch is gated");
  assert.match(lib, /PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH/);
  assert.match(lib, /lower\(env\.FORBID_PRODUCTION\) === "true"/);
  assert.match(lib, /lower\(env\.PAWSPACE_VOICE_ENV\) !== "live"/);
  assert.match(lib, /lower\(env\[FEEDBACK_CALL_TEST_DISPATCH_ENV\]\) === "on"/);
  assert.match(route, /requirePermission\(actor,"communications\.call"\);requirePermission\(actor,"customers\.manage"\)/, "same authority the voice route requires");
  assert.match(route, /if\(actor\.developmentPreview\)throw authFailure\("Permission denied",403\)/, "the preview operator may not run even the synthetic sweep");
  assert.match(route, /feedbackCallPolicyFromEnv/, "policy comes from configuration, not a literal");
  assert.doesNotMatch(route, /maxHorizonMs|dispatchWindowMs/, "the route never supplies policy numbers of its own");
});

test("customer actions are bound to the verified customer session, never to staff, provider or preview identities", () => {
  assert.doesNotMatch(route, /requireCustomerOwnership/, "the shared helper that lets customers.manage, bookings.manage and preview act for any customer is not used");
  assert.match(route, /const session=await resolvePlatformSession\(db,request\);/, "the principal is the platform session");
  assert.match(route, /if\(!session\|\|session\.subjectType!=="customer"\|\|!text\(session\.subjectId\)\)throw authFailure\(CUSTOMER_SIGN_IN_REQUIRED,401\)/, "no customer session means 401, whoever else is signed in");
  assert.match(route, /if\(text\(requestedCustomerId\)&&text\(requestedCustomerId\)!==customerId\)throw authFailure\("Customer ownership denied",403\)/, "a supplied customerId must equal the session subject");
  const customerContext = route.slice(route.indexOf("async function customerContext"), route.indexOf("// Customer: the optional review destinations"));
  assert.doesNotMatch(customerContext, /resolveActor|resolvePrimaryActor|oai-authenticated-user-email|developmentPreview:true|hasPermission/, "the customer context consults no staff header, permission or preview identity");
  assert.match(customerContext, /developmentPreview:false/);
  assert.match(route, /actorId:customerId,policy:feedbackCallPolicyFromEnv/, "the row's actor is the session customer");
  assert.equal((route.match(/resolveActor\(request\)/g) || []).length, 1, "resolveActor appears once, for staff dispatch only");
  assert.match(lib, /NON_PRODUCTION_DEPLOYMENT_MARKERS as readonly string\[\]\)\.includes\(lower\(env\.PAWSPACE_DEPLOYMENT_ENV\)\)/, "an explicit non-production deployment marker is required");
  assert.match(lib, /NON_PRODUCTION_APP_ENVS as readonly string\[\]\)\.includes\(lower\(env\.APP_ENV\)\)/, "an explicit non-production app environment is required");
  assert.doesNotMatch(lib, /"production"\s*\]/, "production is never in a non-production marker list");
});

test("scheduling policy is explicit and validated, with no default numbers in the contract", () => {
  assert.doesNotMatch(lib, /FEEDBACK_CALL_MAX_HORIZON_MS|FEEDBACK_CALL_DISPATCH_WINDOW_MS|30 \* 86_400_000|2 \* 3_600_000/, "the earlier draft defaults are gone");
  assert.match(lib, /policy: FeedbackCallPolicy \| null/, "every scheduling entry point takes the policy explicitly");
  assert.match(lib, /call_policy_unknown/, "unknown policy is a named refusal");
  assert.doesNotMatch(lib, /policy\s*(\?\?|\|\|)\s*\{/, "no inline fallback policy object");
});

test("explicit consent, opt-out, timezone and quiet-hours checks are all present and fail closed", () => {
  for (const reason of ["voice_consent_not_explicit", "global_opt_out", "voice_consent_missing", "voice_opt_out", "service_updates_declined", "timezone_unknown", "quiet_hours_policy_unknown", "phone_unknown", "attempts_exhausted", "call_policy_unknown"]) {
    assert.match(lib, new RegExp(`"${reason}"`), `${reason} is a named refusal`);
  }
  assert.match(lib, /central\.voice_allowed == null \|\| Number\(central\.voice_allowed\) !== 1/, "null central consent is unknown, not allowed");
  assert.match(lib, /Number\(voiceConsent\.granted\) === 1 && voiceConsent\.revoked_at == null/, "revoked phone-level consent refuses");
  assert.match(lib, /localHourIn\(/, "quiet hours use the customer's own IANA zone");
  assert.doesNotMatch(lib, /timeZone:\s*"[A-Za-z]+\/|IST_OFFSET|330 \* 60_000/, "no hard-coded timezone or fixed offset");
  assert.match(lib, /\.catch\(\(\) => null\)/, "a missing owner table reads as unknown");
});

test("the shared booking feedback mount is limited to the import and the two completed-branch mounts", () => {
  assert.equal((mount.match(/PostServiceReviewInvitation/g) || []).length, 3, "one import, two mounts");
  assert.match(mount, /import PostServiceReviewInvitation from '\.\/post-service-review-invitation';/);
  assert.match(mount, /if\(!completed\)return null;/, "the existing completed gate is untouched");
  assert.match(mount, /fetch\('\/api\/identity-session'/, "the existing identity gate is untouched");
  assert.match(mount, /No pending feedback request is available for this booking\. Existing feedback is not resubmitted\./, "the existing error copy is untouched");
  assert.match(mount, /<ServiceFeedbackCard key=\{request\.requestId\} item=\{request\} customerId=\{customerId\} onDone=\{\(_,message\)=>setDone\(message\)\}\/>/, "the private feedback card is untouched");
  assert.match(mount, /\{customerId&&<PostServiceReviewInvitation bookingId=\{bookingId\} customerId=\{customerId\}\/>\}/, "the no-request branch mounts only with a resolved customer");
});

test("owner files do not reference this slice", () => {
  for (const owner of ["lib/service-review-governance.ts", "lib/review-configuration-governance.ts", "lib/voice-outbound-governance.ts", "lib/voice-outbound-canonical.ts", "lib/communication-governance.ts", "lib/communication-engine.ts", "lib/background-scheduler.ts", "lib/lead-callback-governance.ts", "worker/index.ts", "app/api/service-review/route.ts", "app/api/voice-outbound/route.ts"]) {
    assert.doesNotMatch(read(owner), /post-service-feedback|post_service_feedback|PostServiceFeedback/, `${owner} is untouched by this slice`);
  }
});
