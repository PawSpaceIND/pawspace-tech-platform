/**
 * TEST / LOCAL executors for the frozen cohort's Grooming cases, built on the ONE shared harness
 * (tests/helpers/grooming-journey-harness.mjs) and the normal routes. Every actor is a TEST identity in an in-memory
 * SQLite-backed D1; provider GPS/media, payment capture and consent are TEST simulations through the normal sandbox/UAT
 * routes and are labelled as such in each stage record. Nothing here is hosted evidence or a model/voice/payment call.
 */
import assert from "node:assert/strict";
import { runCompletedJourney, routeCall, sessionCookie } from "./grooming-journey-harness.mjs";

export const RUN_DESCRIPTOR = "FINANCE-TEST-OPS-GROOMING-01";
export const future = (hour) => { const now = Date.now(); const start = new Date(now + 3 * 86_400_000); start.setUTCHours(hour, 30, 0, 0); if (start.getTime() <= now + 2 * 60 * 60_000) start.setUTCDate(start.getUTCDate() + 1); return start.toISOString(); };

/** OPS-GROOMING-01 (normal): enquiry -> ... -> consented follow-up. Returns the stage records; asserts along the way. */
export async function executeGroomingNormalJourney(ctx, overrides = {}) {
  const stages = [];
  const record = (stage, actor, outcome, detail) => { stages.push({ stage, actor, outcome, ...detail }); return detail; };
  const { db, sqlite } = ctx;
  const config = { customerId: "CUST-ATLAS-J01", customerName: "Atlas Test Customer", phone: "+919900000701", petSourceId: "PET-ATLAS-J01", petName: "Juno", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "ATLAS-J01-GROOM", couponCode: "UATCARE100", start: future(4), groomingQuote: true, ...overrides };
  const customerCookie = await sessionCookie(db, "customer", config.customerId, `customer:${config.customerId}`);

  // 1. Enquiry: the customer's own signed-in web chat. The deterministic menu bot answers; no model is dispatched.
  const enquiry = await routeCall("../../app/api/ai-web-chat/route.ts", "POST", "/api/ai-web-chat", { mode: "authenticated", bot: true, start: true, customerId: config.customerId }, customerCookie);
  record("1.enquiry", "customer(TEST session)", enquiry.status === 200 ? "autonomous" : "blocked", { status: enquiry.status, threadId: enquiry.body.data?.bot?.threadId ?? null, modelDispatched: false, note: enquiry.status === 200 ? "owned web chat thread opened by menu bot" : JSON.stringify(enquiry.body) });
  assert.equal(enquiry.status, 200, JSON.stringify(enquiry.body));
  const threadId = enquiry.body.data.bot.threadId;
  const replay = await routeCall("../../app/api/ai-web-chat/route.ts", "POST", "/api/ai-web-chat", { mode: "authenticated", bot: true, start: true, customerId: config.customerId }, customerCookie);
  assert.equal(replay.body.data.bot.threadId, threadId, "re-opening never creates a second owned thread");

  // 2. Owned CRM record / transcript: the thread is bound to this customer and readable only as that customer.
  const thread = sqlite.prepare("SELECT id,customer_id,status FROM communication_threads WHERE id=?").get(threadId);
  const messages = sqlite.prepare("SELECT COUNT(*) c FROM communication_messages WHERE thread_id=? AND customer_id=?").get(threadId, config.customerId).c;
  const transcript = await routeCall("../../app/api/ai-web-chat/route.ts", "GET", `/api/ai-web-chat?mode=thread&customerId=${config.customerId}`, null, customerCookie);
  const intruderCookie = await sessionCookie(db, "customer", "CUST-ATLAS-OTHER", "customer:CUST-ATLAS-OTHER");
  // Ownership is the SESSION subject, never a query parameter: another customer naming this thread must see none of it.
  const foreignRead = await routeCall("../../app/api/ai-web-chat/route.ts", "GET", `/api/ai-web-chat?mode=thread&threadId=${threadId}`, null, intruderCookie);
  const foreignLeak = foreignRead.status < 400 && JSON.stringify(foreignRead.body).includes(threadId);
  assert.ok(JSON.stringify(transcript.body).includes(threadId), "the owner sees their own thread");
  record("2.crm_transcript", "customer(TEST session)", thread?.customer_id === config.customerId && messages >= 1 && transcript.status === 200 && !foreignLeak ? "autonomous" : "blocked", { threadId, messages, transcriptStatus: transcript.status, foreignReadStatus: foreignRead.status, foreignThreadVisible: foreignLeak });
  assert.equal(thread.customer_id, config.customerId); assert.ok(messages >= 1); assert.equal(transcript.status, 200, JSON.stringify(transcript.body)); assert.equal(foreignLeak, false, "another customer cannot read the owned transcript");

  // 3. Scoped quote: governed Grooming quote (lib/grooming-commercial-governance) priced by the canonical live
  //    governance and pinned with the coupon quote, created by the customer's own session inside the shared harness.
  //    4. Explicit acceptance = the customer's authenticated booking POST naming the quote; the link row is the record.
  // 4-6. Explicit customer confirmation = the customer-authenticated canonical booking POST with the idempotency key
  //      (there is no separate accept-quote endpoint: GAP). Reservation, canonical booking, work order, assignment,
  //      TEST sandbox payment capture, provider lifecycle with TEST GPS and TEST media, completion.
  const result = await runCompletedJourney(ctx, config);
  const quoteOk = result.groomingQuote && result.persisted.quote?.status === "used" && result.persisted.quoteLink?.booking_id === result.bookingId && result.persisted.quote.final_payable_minor === Math.round(result.groomingQuote.finalPayable * 100) && result.persisted.quote.coupon_quote_id === result.groomingQuote.couponQuoteId && result.persisted.quote.payment_mode === "prepaid";
  record("3.scoped_quote", "customer(TEST session) via canonical live governance", quoteOk ? "autonomous" : "blocked", { quoteId: result.groomingQuote?.quoteId ?? null, priceSource: result.groomingQuote?.priceSource ?? null, finalPayable: result.groomingQuote?.finalPayable ?? null, baseAmount: result.groomingQuote?.baseAmount ?? null, couponDiscount: result.groomingQuote?.couponDiscount ?? null, declaredPets: result.groomingQuote?.pets ?? null, couponQuoteId: result.groomingQuote?.couponQuoteId ?? null, catalogueVersion: result.groomingQuote?.catalogueVersion ?? null, previousGap: "closed in this lane: grooming_commercial_quotes + grooming_booking_quote_links, price from quoteGroomingBookingWithLiveMultiPet" });
  assert.ok(quoteOk, JSON.stringify({ quote: result.persisted.quote, link: result.persisted.quoteLink }));
  record("4.customer_confirmation", "customer(TEST session)", result.booked.status === 201 && result.bookingReplay.body.data?.duplicatePrevented === true && quoteOk ? "autonomous" : "blocked", { bookingStatus: result.booked.status, replayDuplicatePrevented: result.bookingReplay.body.data?.duplicatePrevented, idempotencyKey: config.groupId, acceptanceRecord: result.persisted.quoteLink ? { quoteId: result.persisted.quoteLink.quote_id, bookingId: result.persisted.quoteLink.booking_id } : null, previousGap: "closed: acceptance is the quote link written by the customer's booking POST" });
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body)); assert.equal(result.bookingReplay.body.data.duplicatePrevented, true);
  record("5.reservation_booking_workorder", "customer(TEST session) + scheduler", result.scheduled.status === 200 && result.persisted.reservation && result.persisted.work ? "autonomous" : "blocked", { scheduleStatus: result.scheduled.status, scheduleReplayDuplicatePrevented: result.scheduleReplay.body.data?.duplicatePrevented, reservationId: result.persisted.reservation?.id ?? null, workOrderId: result.persisted.work?.id ?? null, bookingId: result.bookingId });
  assert.equal(result.scheduled.status, 200); assert.equal(result.scheduleReplay.body.data.duplicatePrevented, true); assert.ok(result.persisted.reservation); assert.ok(result.persisted.work);
  record("6.assignment", "scheduler(governed capacity)", result.persisted.booking.provider_id === result.provider.id && result.jobs.status === 200 ? "autonomous" : "blocked", { providerId: result.provider.id, visibleInProviderFeed: result.jobs.body.jobs?.some((job) => job.bookingId === result.bookingId) ?? false });
  assert.equal(result.persisted.booking.provider_id, result.provider.id);
  record("6b.payment_capture", "TEST sandbox gateway event (simulated)", result.captured.status < 300 && result.captureReplay.body.data?.result?.duplicate === true ? "manual" : "blocked", { status: result.captured.status, replayDuplicate: result.captureReplay.body.data?.result?.duplicate, paymentStatus: result.persisted.payment?.status, commercialMode: result.bookingPayload.payment.mode, label: "TEST simulate_event via grooming-payment-sandbox; no gateway, no money" });
  assert.equal(result.persisted.payment.status, "captured"); assert.equal(result.captureReplay.body.data.result.duplicate, true);
  record("7.provider_lifecycle_media", "provider(TEST session) with TEST GPS + TEST media bytes", result.transitions.every((s) => s.status === 200) && result.invalidEarlyComplete.status === 409 && result.proof.status === 200 && result.completed.status === 200 ? "manual" : "blocked", { transitions: result.transitions.map((s) => s.status), completeWithoutProof: result.invalidEarlyComplete.status, proofStatus: result.proof.status, completeStatus: result.completed.status, workOrderStatus: result.persisted.work.status, label: "physical grooming is external provider input; simulated here" });
  assert.deepEqual(result.transitions.map((s) => s.status), [200, 200, 200, 200]); assert.equal(result.invalidEarlyComplete.status, 409); assert.equal(result.completed.status, 200, JSON.stringify(result.completed.body)); assert.equal(result.persisted.work.status, "completed");
  const intruder = await sessionCookie(db, "provider", "groom_kiran", "provider:groom_kiran");
  const forbidden = await routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId: result.bookingId, action: "complete" }, intruder);
  assert.equal(forbidden.status, 403, "a non-assigned provider cannot act on the work order");

  // 8. Completion-triggered invoice and balanced accounts (same request as `complete`; replay must not repeat finance).
  const invoice = sqlite.prepare("SELECT id,invoice_number,booking_id,status FROM booking_invoices WHERE booking_id=?").all(result.bookingId);
  const journalTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_journal_entries'").get();
  const columns = journalTable ? sqlite.prepare("PRAGMA table_info(finance_journal_entries)").all().map((c) => c.name) : [];
  const journal = journalTable ? sqlite.prepare("SELECT * FROM finance_journal_entries").all() : [];
  const bookingJournal = journal.filter((row) => JSON.stringify(row).includes(result.bookingId));
  const sum = (key) => bookingJournal.reduce((acc, row) => { const lines = (() => { try { return JSON.parse(row.lines_json ?? row.entries_json ?? "[]"); } catch { return []; } })(); return acc + lines.reduce((a, l) => a + Number(l[key] ?? 0), 0); }, 0);
  const debits = columns.includes("lines_json") || columns.includes("entries_json") ? sum("debit") : Number(bookingJournal.reduce((a, r) => a + Number(r.debit ?? r.debit_minor ?? 0), 0));
  const credits = columns.includes("lines_json") || columns.includes("entries_json") ? sum("credit") : Number(bookingJournal.reduce((a, r) => a + Number(r.credit ?? r.credit_minor ?? 0), 0));
  const completeReplay = await routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId: result.bookingId, action: "complete" }, await sessionCookie(db, "provider", result.provider.id, `provider:${result.provider.id}`));
  const invoiceAfter = sqlite.prepare("SELECT COUNT(*) c FROM booking_invoices WHERE booking_id=?").get(result.bookingId).c;
  const journalAfter = journalTable ? sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c : 0;
  record("8.invoice_accounts", "system(completion finance)", invoice.length === 1 && bookingJournal.length > 0 && debits === credits && debits > 0 && invoiceAfter === 1 && journalAfter === journal.length ? "autonomous" : "blocked", { invoices: invoice.length, invoiceNumber: invoice[0]?.invoice_number ?? null, journalEntriesForBooking: bookingJournal.length, debits, credits, balanced: debits === credits, completeReplayStatus: completeReplay.status, invoiceCountAfterReplay: invoiceAfter, journalCountAfterReplay: journalAfter, journalColumns: columns });
  assert.equal(invoice.length, 1, "exactly one invoice"); assert.ok(bookingJournal.length > 0, `journal entries exist for the booking (table columns: ${columns.join(",")})`); assert.equal(debits, credits, "journal is balanced"); assert.ok(debits > 0);
  assert.equal(invoiceAfter, 1, "completion replay never issues a second invoice"); assert.equal(journalAfter, journal.length, "completion replay never re-posts finance");

  // 9. Consented follow-up: the CUSTOMER (TEST session) asks for a feedback call with explicit consent. Eligibility is
  //    governed (completed owned booking, phone, timezone, city quiet-hours policy, catalogue). A governed refusal
  //    is recorded as its exact reason, never relabelled as success.
  // runCompletedJourney issued the customer a fresh platform session (one live session per binding), so the first cookie is superseded.
  // Legitimate TEST consent/policy contracts, each through an existing writer and each labelled TEST:
  //  - call policy: the route's own env contract (feedbackCallPolicyFromEnv)
  //  - city quiet hours: seedCommunicationPolicy (blr)
  //  - customer timezone/service updates: setCommunicationPreference (writer fixes Asia/Kolkata)
  //  - explicit voice consent record: recordVoiceConsent with a TEST source
  //  - central channel consent: the governed customer-owned writer route (new in this lane), as the TEST customer
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "336", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES: "90" });
  const { seedCommunicationPolicy, setCommunicationPreference } = await import("../../lib/communication-engine.ts");
  const { recordVoiceConsent } = await import("../../lib/voice-outbound-governance.ts");
  await seedCommunicationPolicy(db);
  await setCommunicationPreference(db, { customerId: config.customerId, serviceUpdates: true, source: "TEST_synthetic_first_journey" });
  const voiceConsent = await recordVoiceConsent(db, { phone: config.phone, subjectType: "customer", subjectId: config.customerId, granted: true, source: "TEST_synthetic_first_journey_consent", actorId: "TEST:" + config.customerId });
  // Central channel consent through the governed customer-owned writer (app/api/customer-communication-consent), acting as
  // the TEST customer's own session. This is a TEST consent record, never a real customer's consent; no row is inserted directly.
  const centralConsent = await routeCall("../../app/api/customer-communication-consent/route.ts", "POST", "/api/customer-communication-consent", { channel: "voice", allowed: true, source: "customer_app_settings" }, result.customerCookie);
  assert.equal(centralConsent.status, 201, JSON.stringify(centralConsent.body));
  const foreignConsent = await routeCall("../../app/api/customer-communication-consent/route.ts", "POST", "/api/customer-communication-consent", { customerId: config.customerId, channel: "voice", allowed: true }, intruderCookie);
  assert.equal(foreignConsent.status, 403, "another customer cannot write this customer's consent");
  const eligibility = await routeCall("../../app/api/post-service-feedback/route.ts", "GET", `/api/post-service-feedback?bookingId=${result.bookingId}&customerId=${config.customerId}`, null, result.customerCookie);
  const preferredAt = new Date(Date.now() + 86_400_000); preferredAt.setUTCHours(6, 30, 0, 0); // 12:00 IST, outside any quiet window
  const followUpBody = { action: "schedule_call", bookingId: result.bookingId, customerId: config.customerId, preferredAt: preferredAt.toISOString(), consentConfirmed: true };
  const followUp = await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", followUpBody, result.customerCookie);
  const noConsent = await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", { ...followUpBody, consentConfirmed: false }, result.customerCookie);
  const followUpReplay = followUp.status < 300 ? await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", followUpBody, customerCookie) : null;
  const scheduledRows = (() => { try { return sqlite.prepare("SELECT COUNT(*) c FROM post_service_feedback_calls WHERE booking_id=?").get(result.bookingId).c; } catch { return 0; } })();
  const governedRefusal = followUp.status === 412 || followUp.status === 409;
  record("9.consented_followup", "customer(TEST session; TEST consent via governed writer)", followUp.status < 300 && scheduledRows === 1 && noConsent.status >= 400 ? "manual(TEST consent; synthetic customer)" : governedRefusal ? "blocked(governed: " + (followUp.body?.error ?? followUp.body?.code) + ")" : "blocked", { eligibilityStatus: eligibility.status, eligibility: eligibility.body.data ?? eligibility.body, scheduleStatus: followUp.status, scheduleBody: followUp.body, withoutConsentStatus: noConsent.status, replayDuplicatePrevented: followUpReplay?.body?.data?.duplicatePrevented ?? null, persistedCalls: scheduledRows, voiceConsentRecord: voiceConsent ? "recorded(TEST source)" : null, centralConsentRecord: centralConsent.body.data ?? null, label: "consent is a TEST flag from a TEST customer session, not a real customer's consent" });
  assert.ok(noConsent.status >= 400, "a follow-up without explicit consent is refused");
  assert.ok(followUp.status < 300 || governedRefusal, `follow-up either scheduled or governed-refused: ${followUp.status} ${JSON.stringify(followUp.body)}`);
  if (governedRefusal) assert.equal(scheduledRows, 0, "a governed refusal persists no call");
  return { stages, result, config };
}

/**
 * OPS-GROOMING-02 (cancel_refund): same chain through booking/assignment and TEST capture, then the CUSTOMER cancels through
 * the normal change route. Capacity release and the refund case are observed. Refund/reversal processing is NOT executed here:
 * the cohort lists "Finance authorization for refund/reversal where policy requires" as a mandatory approval, and a gateway
 * refund event is an external input; this executor stops at that boundary and records it as blocked. No automatic refund.
 */
export async function executeGroomingCancelRefundJourney(ctx, overrides = {}) {
  const stages = [];
  const record = (stage, actor, outcome, detail) => { stages.push({ stage, actor, outcome, ...detail }); return detail; };
  const config = { customerId: "CUST-ATLAS-J02", customerName: "Atlas Cancel Customer", phone: "+919900000702", petSourceId: "PET-ATLAS-J02", petName: "Juno", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "ATLAS-J02-GROOM", couponCode: "UATCARE100", start: future(5), groomingQuote: true, stopAfterCapture: true, ...overrides };
  const result = await runCompletedJourney(ctx, config);
  const quoteOk = result.groomingQuote && result.persisted?.quote?.status === "used" || (result.groomingQuote && ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(result.groomingQuote.quoteId)?.status === "used");
  record("1-6.chain_to_assignment", "customer(TEST session) + scheduler", result.scheduled.status === 200 && result.booked.status === 201 && quoteOk ? "autonomous" : "blocked", { scheduleStatus: result.scheduled.status, bookingStatus: result.booked.status, bookingId: result.bookingId, quoteId: result.groomingQuote?.quoteId ?? null, providerId: result.provider?.id ?? null });
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  record("6b.payment_capture", "TEST sandbox gateway event (simulated)", result.captured.status < 300 ? "manual" : "blocked", { status: result.captured.status, label: "TEST simulate_event; no gateway, no money" });
  const cancel = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: result.bookingId, customerId: config.customerId, action: "cancel", reason: "TEST customer requested cancellation" }, result.customerCookie);
  const cancelReplay = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: result.bookingId, customerId: config.customerId, action: "cancel", reason: "TEST customer requested cancellation retry" }, result.customerCookie);
  const reservation = ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(config.groupId);
  const work = ctx.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(result.bookingId);
  const booking = ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId);
  record("7.customer_cancellation", "customer(TEST session)", cancel.status === 200 && booking?.status === "cancelled" ? "autonomous" : cancel.status === 409 && cancel.body?.code === "cancellation_requires_approval" ? "blocked(governed: cancellation_requires_approval)" : "blocked", { status: cancel.status, code: cancel.body?.code ?? null, replayStatus: cancelReplay.status, bookingStatus: booking?.status ?? null, refundAmountEvaluated: cancel.body?.data?.refundAmount ?? null, refundPolicy: cancel.body?.data?.refundPolicy ?? cancel.body?.refundPolicy ?? null });
  record("8.capacity_release", "system(cancellation)", reservation?.status === "cancelled" && work?.status === "cancelled" ? "autonomous" : "blocked", { reservationStatus: reservation?.status ?? null, workOrderStatus: work?.status ?? null });
  const refundCases = ctx.sqlite.prepare("SELECT id,status,amount FROM booking_refund_cases WHERE booking_id=?").all(result.bookingId);
  const payment = ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(result.bookingId);
  record("9.refund_or_approval_pending", "Finance authority (external) / gateway refund event (external)", "blocked(Finance authorization for refund/reversal; gateway refund event not simulated here)", { refundCases, paymentStatus: payment?.status ?? null, note: "cohort mandatoryApprovals; no automatic refund, no simulated refund.processed event in this executor" });
  record("10.credit_reversal_reconciliation", "Finance", "not_executed(depends on stage 9 authority)", {});
  record("11.consented_followup", "customer", "not_executed(booking not completed; follow-up eligibility requires a completed service)", {});
  return { stages, result, config, cancel };
}
