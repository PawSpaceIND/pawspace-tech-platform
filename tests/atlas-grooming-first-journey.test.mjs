/**
 * TEST / LOCAL. First executable NORMAL Grooming journey, end to end through the real route handlers, one shared
 * harness (tests/helpers/grooming-journey-harness.mjs) and one run descriptor (FINANCE-TEST-OPS-GROOMING-01).
 *
 * enquiry -> owned CRM thread/transcript -> scoped quote -> explicit customer confirmation -> capacity reservation /
 * canonical booking / work order -> assignment -> authenticated provider lifecycle + media completion -> completion-
 * triggered invoice + balanced journal -> consented follow-up.
 *
 * Every actor here is a TEST identity created in an in-memory SQLite-backed D1. Provider GPS, media bytes, payment
 * capture and customer consent are TEST SIMULATIONS through the normal sandbox/UAT routes. Nothing here is hosted
 * evidence, a model call, an outbound message, or a real payment. The packet printed at the end feeds the 21-row
 * ledger in docs/atlas/ATLAS_JOURNEY_LEDGER.md as the "local executable" column only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

export const RUN_DESCRIPTOR = "FINANCE-TEST-OPS-GROOMING-01";
const future = (hour) => { const now = Date.now(); const start = new Date(now + 3 * 86_400_000); start.setUTCHours(hour, 30, 0, 0); if (start.getTime() <= now + 2 * 60 * 60_000) start.setUTCDate(start.getUTCDate() + 1); return start.toISOString(); };
const stages = [];
const record = (stage, actor, outcome, detail) => { stages.push({ stage, actor, outcome, ...detail }); return detail; };

test(`[${RUN_DESCRIPTOR}] TEST first normal Grooming journey: enquiry to consented follow-up through real routes`, async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const { db, sqlite } = ctx;
  const config = { customerId: "CUST-ATLAS-J01", customerName: "Atlas Test Customer", phone: "+919900000701", petSourceId: "PET-ATLAS-J01", petName: "Juno", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "ATLAS-J01-GROOM", couponCode: "UATCARE100", start: future(4) };
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

  // 3. Scoped quote: Grooming has no persisted commercial quote table (training/sitting/etc do). The persisted,
  //    customer-scoped artefact available on the normal path is the coupon quote; the price itself is governed
  //    server-side at booking (client package name/price are overridden). Recorded as a GAP, not papered over.
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  const quote = await quoteCoupon(db, { code: config.couponCode, customerId: config.customerId, serviceCode: "grooming", cityId: config.cityId, channel: "customer_app", packageCode: "dog-basic", orderValue: 1899, paymentMode: "full", isSubscription: false });
  const quoteRow = sqlite.prepare("SELECT id,customer_id,status FROM coupon_quotes WHERE id=?").get(quote.quoteId);
  record("3.scoped_quote", "system(coupon governance) for customer", quote.valid && quoteRow?.customer_id === config.customerId ? "manual" : "blocked", { quoteId: quote.quoteId, finalAmount: quote.finalAmount, gap: "no Grooming commercial_quotes table or quote route; only coupon quote persisted, package price governed at booking" });
  assert.equal(quote.valid, true, JSON.stringify(quote)); assert.equal(quoteRow.customer_id, config.customerId);

  // 4-6. Explicit customer confirmation = the customer-authenticated canonical booking POST with the idempotency key
  //      (there is no separate accept-quote endpoint: GAP). Reservation, canonical booking, work order, assignment,
  //      TEST sandbox payment capture, provider lifecycle with TEST GPS and TEST media, completion.
  const result = await runCompletedJourney(ctx, config);
  record("4.customer_confirmation", "customer(TEST session)", result.booked.status === 201 && result.bookingReplay.body.data?.duplicatePrevented === true ? "autonomous" : "blocked", { bookingStatus: result.booked.status, replayDuplicatePrevented: result.bookingReplay.body.data?.duplicatePrevented, idempotencyKey: config.groupId, gap: "confirmation is the booking POST; no explicit quote-acceptance record" });
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
  const eligibility = await routeCall("../../app/api/post-service-feedback/route.ts", "GET", `/api/post-service-feedback?bookingId=${result.bookingId}&customerId=${config.customerId}`, null, result.customerCookie);
  const preferredAt = new Date(Date.now() + 86_400_000); preferredAt.setUTCHours(6, 30, 0, 0); // 12:00 IST, outside any quiet window
  const followUpBody = { action: "schedule_call", bookingId: result.bookingId, customerId: config.customerId, preferredAt: preferredAt.toISOString(), consentConfirmed: true };
  const followUp = await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", followUpBody, result.customerCookie);
  const noConsent = await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", { ...followUpBody, consentConfirmed: false }, result.customerCookie);
  const followUpReplay = followUp.status < 300 ? await routeCall("../../app/api/post-service-feedback/route.ts", "POST", "/api/post-service-feedback", followUpBody, customerCookie) : null;
  const scheduledRows = (() => { try { return sqlite.prepare("SELECT COUNT(*) c FROM post_service_feedback_calls WHERE booking_id=?").get(result.bookingId).c; } catch { return 0; } })();
  const governedRefusal = followUp.status === 412 || followUp.status === 409;
  record("9.consented_followup", "customer(TEST session; TEST consent flag)", followUp.status < 300 && scheduledRows === 1 && noConsent.status >= 400 ? "manual" : governedRefusal ? "blocked(governed: " + (followUp.body?.error ?? followUp.body?.code) + ")" : "blocked", { eligibilityStatus: eligibility.status, eligibility: eligibility.body.data ?? eligibility.body, scheduleStatus: followUp.status, scheduleBody: followUp.body, withoutConsentStatus: noConsent.status, replayDuplicatePrevented: followUpReplay?.body?.data?.duplicatePrevented ?? null, persistedCalls: scheduledRows, label: "consent is a TEST flag from a TEST customer session, not a real customer's consent" });
  assert.ok(noConsent.status >= 400, "a follow-up without explicit consent is refused");
  assert.ok(followUp.status < 300 || governedRefusal, `follow-up either scheduled or governed-refused: ${followUp.status} ${JSON.stringify(followUp.body)}`);
  if (governedRefusal) assert.equal(scheduledRows, 0, "a governed refusal persists no call");
});

test.after(() => { console.log("FIRST_JOURNEY_PACKET " + JSON.stringify({ runDescriptor: RUN_DESCRIPTOR, label: "TEST/LOCAL executable journey; not hosted whole-job evidence", stages }, null, 1)); });
