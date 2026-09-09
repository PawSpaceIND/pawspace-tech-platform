import { expect, request } from "@playwright/test";

const ADMIN = "e2e.admin@pawspace.test";
const FINANCE = "e2e.finance@pawspace.test";
const PROVIDER_ID = "groom_arun";

async function expectOk(response: Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>["get"]>>, label: string) {
  const text = await response.text();
  expect(response.ok(), `${label} failed: ${response.status()} ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : {};
}

export async function runCancellationRefundRecovery(baseURL: string, cancellation: any) {
  const admin = await request.newContext({ baseURL, extraHTTPHeaders: { "oai-authenticated-user-email": ADMIN } });
  const finance = await request.newContext({ baseURL, extraHTTPHeaders: { "oai-authenticated-user-email": FINANCE } });
  try {
    const bookingId = String(cancellation?.bookingId || "");
    const groupId = String(cancellation?.groupId || "");
    expect(bookingId).toBeTruthy();
    expect(groupId).toBeTruthy();

    const outcomes = Array.isArray(cancellation?.cancellations) ? cancellation.cancellations : [];
    const successful = outcomes.filter((result: any) => Number(result.status) === 200);
    const conflicts = outcomes.filter((result: any) => Number(result.status) === 409);
    expect(successful, "exactly one cancellation must win the double tap").toHaveLength(1);
    expect(conflicts, "the competing cancellation must be rejected").toHaveLength(1);

    const refundCaseId = String(successful[0]?.body?.data?.refundCaseId || "");
    expect(refundCaseId).toBeTruthy();
    expect(Number(successful[0]?.body?.data?.refundAmount)).toBe(1899);

    const communication = successful[0]?.body?.data?.customerCommunication || {};
    expect(Number(communication.failed || 0), JSON.stringify(communication)).toBe(0);
    expect(Number(communication.enqueued || 0) + Number(communication.duplicates || 0) + Number(communication.suppressed || 0)).toBeGreaterThan(0);

    const operationsAfterCancel = await expectOk(
      await admin.get(`/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`),
      "cancellation operations visibility",
    );
    expect(operationsAfterCancel.data.refunds.filter((item: any) => String(item.id) === refundCaseId)).toHaveLength(1);
    expect(
      operationsAfterCancel.data.notifications.some((item: any) => item.template_code === "grooming_booking_cancelled_refund_pending"),
      "direct cancellation must persist a customer notification",
    ).toBe(true);

    const scheduledDay = String(cancellation?.adminView?.scheduled_start || "").slice(0, 10);
    expect(scheduledDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const scheduleBoard = await expectOk(await admin.get(`/api/uat-scheduling?date=${scheduledDay}`), "cancelled capacity visibility");
    const reservations = (scheduleBoard.data.providers || []).flatMap((provider: any) => provider.reservations || []);
    const releasedReservation = reservations.find((item: any) => item.groupId === groupId);
    expect(releasedReservation, JSON.stringify(reservations.slice(0, 20))).toBeTruthy();
    expect(releasedReservation.status).toBe("cancelled");
    expect(releasedReservation.decisionStatus).toBe("cancelled");

    await expectOk(
      await finance.post("/api/booking-operations", {
        data: {
          bookingId,
          providerId: PROVIDER_ID,
          action: "refund_status",
          reason: "Finance checker approved the cancellation refund",
          refundCaseId,
          refundStatus: "approved",
        },
      }),
      "finance refund approval",
    );

    const token = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const gatewayRefundId = `rfnd_uat_${token.slice(-16)}`;
    const failedEventId = `evt_refund_failed_${token.slice(-12)}`;
    await expectOk(
      await finance.post("/api/grooming-payment-sandbox", {
        data: { action: "simulate_event", bookingId, eventType: "refund.failed", eventId: failedEventId, gatewayRefundId, amount: 1899, currency: "INR" },
      }),
      "failed refund callback",
    );

    const afterFailure = await expectOk(
      await admin.get(`/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`),
      "refund failure visibility",
    );
    expect(afterFailure.data.refunds.find((item: any) => String(item.id) === refundCaseId)?.status).toBe("failed");

    await expectOk(await admin.post("/api/ops-work-queue", { data: { action: "sweep" } }), "finance work queue sweep");
    const queueBody = await expectOk(await admin.get("/api/ops-work-queue"), "finance work queue visibility");
    const queueTasks = Object.values(queueBody.data.queues || {}).flatMap((queue: any) => queue.tasks || []);
    const staffAlert = queueTasks.find((task: any) => task.rule === "refund_failed" && task.booking_id === bookingId);
    expect(staffAlert, JSON.stringify(queueTasks.slice(0, 20))).toBeTruthy();
    expect(staffAlert.queue).toBe("finance");
    expect(staffAlert.priority).toBe("critical");

    await expectOk(
      await finance.post("/api/booking-operations", {
        data: {
          bookingId,
          providerId: PROVIDER_ID,
          action: "refund_status",
          reason: "Finance retried the failed gateway refund",
          refundCaseId,
          refundStatus: "processing",
        },
      }),
      "governed failed refund recovery",
    );
    const afterRecovery = await expectOk(
      await admin.get(`/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`),
      "refund recovery visibility",
    );
    expect(afterRecovery.data.refunds.find((item: any) => String(item.id) === refundCaseId)?.status).toBe("processing");

    const analyticsBefore = await expectOk(
      await admin.get(`/api/company-analytics?from=${scheduledDay}&to=${scheduledDay}&serviceCode=grooming`),
      "analytics before refund completion",
    );
    expect(Number(analyticsBefore.data.money.refunds || 0), "processing refund must not reduce collections").toBe(0);

    const processedEventId = `evt_refund_processed_${token.slice(-12)}`;
    await expectOk(
      await finance.post("/api/grooming-payment-sandbox", {
        data: { action: "simulate_event", bookingId, eventType: "refund.processed", eventId: processedEventId, gatewayRefundId, amount: 1899, currency: "INR" },
      }),
      "processed refund callback",
    );

    const exactReplay = await expectOk(
      await finance.post("/api/grooming-payment-sandbox", {
        data: { action: "simulate_event", bookingId, eventType: "refund.processed", eventId: processedEventId, gatewayRefundId, amount: 1899, currency: "INR" },
      }),
      "duplicate processed refund callback",
    );
    expect(exactReplay.data.result.duplicate).toBe(true);

    const logicalReplay = await expectOk(
      await finance.post("/api/grooming-payment-sandbox", {
        data: { action: "simulate_event", bookingId, eventType: "refund.processed", eventId: `${processedEventId}_logical`, gatewayRefundId, amount: 1899, currency: "INR" },
      }),
      "logical refund replay",
    );
    expect(logicalReplay.data.result.reason).toBe("refund_already_processed");

    const delayedFailure = await expectOk(
      await finance.post("/api/grooming-payment-sandbox", {
        data: { action: "simulate_event", bookingId, eventType: "refund.failed", eventId: `${failedEventId}_late`, gatewayRefundId, amount: 1899, currency: "INR" },
      }),
      "delayed failed refund callback",
    );
    expect(delayedFailure.data.result.reason).toBe("out_of_order_refund_failed");

    const finalOps = await expectOk(
      await admin.get(`/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`),
      "final refund state",
    );
    expect(finalOps.data.refunds.find((item: any) => String(item.id) === refundCaseId)?.status).toBe("processed");

    const finalAdmin = await expectOk(await admin.get("/api/canonical-bookings"), "final admin cancellation visibility");
    const finalRow = finalAdmin.bookings.find((item: any) => String(item.id) === bookingId);
    expect(finalRow.status).toBe("cancelled");
    expect(finalRow.work_order_status).toBe("cancelled");
    expect(finalRow.payment_status).toBe("refunded");

    const analyticsAfter = await expectOk(
      await admin.get(`/api/company-analytics?from=${scheduledDay}&to=${scheduledDay}&serviceCode=grooming`),
      "analytics after refund completion",
    );
    expect(Number(analyticsAfter.data.money.refunds || 0)).toBe(1899);

    const financeControl = await expectOk(await finance.get("/api/finance-control"), "finance journal visibility");
    const refundJournal = (financeControl.data.journals || []).filter(
      (item: any) => item.source_type === "refund_completed" && item.source_id === gatewayRefundId,
    );
    expect(refundJournal, "refund must post one balanced two-line journal").toHaveLength(2);
    const refundDebit = refundJournal.reduce((sum: number, item: any) => sum + Number(item.debit || 0), 0);
    const refundCredit = refundJournal.reduce((sum: number, item: any) => sum + Number(item.credit || 0), 0);
    expect(refundDebit).toBe(1899);
    expect(refundCredit).toBe(1899);
    expect(refundDebit).toBe(refundCredit);

    return {
      bookingId,
      groupId,
      refundCaseId,
      gatewayRefundId,
      staffAlert,
      customerCommunication: communication,
      releasedReservation,
      adminView: finalRow,
      analyticsBefore: analyticsBefore.data.money,
      analyticsAfter: analyticsAfter.data.money,
      refundJournal,
      paymentMode: "sandbox",
      evidenceKind: "built-worker-http-local-d1-cancellation-refund-recovery",
    };
  } finally {
    await Promise.all([admin.dispose(), finance.dispose()]);
  }
}
