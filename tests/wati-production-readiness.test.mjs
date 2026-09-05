/*
 * LIVE FINDING - do not "fix" the assertion below to get green.
 *
 *   assert.doesNotMatch(interakt, /recordDeliveryEvent/)
 *
 * It fails because lib/interakt-whatsapp.ts writes its send-acceptance event with
 * recordDeliveryEvent from lib/communication-engine.ts, and that recorder has NO
 * shouldApplyDeliveryTransition and NO regressionPrevented - verified by reading it. The webhook
 * delivery path IS atomic (asserted above via recordWhatsAppDeliveryEventAtomic); it is the
 * send-accept write that bypasses the regression guard.
 *
 * Concretely: an Interakt webhook reporting `delivered` can land between the send path storing the
 * provider reference and writing its own `accepted` event, and the non-guarded write then moves the
 * message backwards from delivered to accepted. That is the exact regression
 * recordWhatsAppDeliveryEventAtomic was built for in #419.
 *
 * Fixing it means changing lib/interakt-whatsapp.ts, which is production code and therefore out of
 * scope for this test-only branch. It needs its own PR. The guard stays red until then, on purpose.
 */
/*
 * Despite the filename this is the POST-WATI suite: every test here guards the Meta WhatsApp and
 * Interakt production paths. It is not obsolete and must not be pruned - PR #392 moved the platform
 * off WATI, and these are the guards over what replaced it.
 *
 * Source contracts follow the current implementation boundaries:
 *
 *   inbound media   processMetaWhatsAppEvents owns active message routing and calls
 *                   ingestMetaInboundMediaRetrySafe; the API route delegates message events to it
 *   outbox drain    runCommunicationOutboxDispatcher, renamed from drainCommunicationOutbox
 *   interakt atomic lib/interakt-delivery-atomic.ts -> recordWhatsAppDeliveryEventAtomic in
 *                   lib/whatsapp-production-runtime.ts; the batch, regression-prevention and
 *                   dead-letter properties are asserted there directly
 *   CX polling      setInterval transport is asserted on the active CX surface
 *   template copy   "No manual approval" reworded to "cannot fabricate provider approval"
 */
import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");
test("Meta webhook supports secure R2 media ingestion without dropping text or interactive routing",()=>{const webhook=read("lib/meta-whatsapp-webhook.ts"),media=read("lib/meta-whatsapp-media.ts"),inboundRoute=read("app/api/whatsapp/meta-webhook/route.ts");for(const type of["image","audio","video","document"])assert.match(media,new RegExp(`\\"${type}\\"`));assert.match(webhook,/ingestMetaInboundMediaRetrySafe/);assert.match(inboundRoute,/processMetaWhatsAppEvents\(env\.DB,messages,rawBody,env/);assert.match(webhook,/recordWhatsAppInteractiveSubmission/);assert.match(webhook,/routeInboundAutomation/);assert.match(media,/PAWSPACE_MEDIA_BUCKET/);assert.match(media,/SHA-256/);assert.match(media,/r2:\/\/PAWSPACE_MEDIA_BUCKET/);});
test("scheduled worker drains WhatsApp communication outbox to Meta or Interakt",()=>{const worker=read("worker/index.ts"),dispatcher=read("lib/communication-outbox-dispatcher.ts"),providerRuntime=read("lib/whatsapp-production-runtime.ts");assert.match(worker,/runCommunicationOutboxDispatcher/);assert.match(dispatcher,/communication_outbox/);assert.match(providerRuntime,/dispatchInteraktWhatsApp/);assert.match(providerRuntime,/dispatchMetaCloudWhatsApp/);assert.match(providerRuntime,/unknown_provider/);});
test("delivery state helper atomically prevents regression and couples retry dead-letter state with event log",()=>{const source=read("lib/communication-delivery-state.ts"),meta=read("lib/meta-whatsapp-dispatch.ts"),interakt=read("lib/interakt-whatsapp.ts"),interaktAtomic=read("lib/interakt-delivery-atomic.ts"),whatsappRuntime=read("lib/whatsapp-production-runtime.ts");assert.match(source,/db\.batch\(statements\)/);assert.match(source,/shouldApplyDeliveryTransition/);assert.match(source,/regressionPrevented/);assert.match(source,/communication_dead_letters/);assert.match(source,/provider_reference=COALESCE/);assert.match(meta,/recordAtomicDeliveryEvent/);assert.match(interaktAtomic,/recordWhatsAppDeliveryEventAtomic/);assert.match(whatsappRuntime,/db\.batch/);assert.match(whatsappRuntime,/regressionPrevented/);assert.match(whatsappRuntime,/communication_dead_letters/);assert.doesNotMatch(interakt,/recordDeliveryEvent/);});
test("CX inbox refreshes threads conversation and controls automatically",()=>{const source=read("app/team/customer-experience/page.tsx"),shell=read("app/team/customer-experience/template.tsx");assert.match(shell,/setInterval/);assert.match(source,/loadThreads/);assert.match(source,/loadConversation/);assert.match(source,/loadControl/);assert.match(source,/human_reply/);});
test("template approval is verified live against Meta Graph API with no manual reconciliation route",()=>{const route=read("app/api/whatsapp/templates/route.ts"),verify=read("lib/meta-whatsapp-template-verification.ts"),page=read("app/team/whatsapp/templates/page.tsx");assert.match(route,/verify_meta/);assert.doesNotMatch(route,/reconcileWhatsAppTemplate/);assert.match(verify,/graph\.facebook\.com/);assert.match(verify,/verifiedAgainstMeta:true/);assert.match(page,/Verify with Meta/);assert.match(page,/cannot fabricate provider approval/);});
test("production readiness registry declares the implemented WhatsApp production handlers",()=>{const source=read("lib/production-readiness-enforcement.mjs");assert.match(source,/id:"whatsapp_messaging"/);for(const name of["inbound_media_r2_ingestion","scheduled_outbox_dispatch","atomic_delivery_state","realtime_team_inbox","live_meta_template_verification"])assert.match(source,new RegExp(`name:\\"${name}\\",state:\\"implemented\\"`));});
