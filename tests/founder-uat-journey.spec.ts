import { test, expect, request as playwrightRequest } from "@playwright/test";

const BASE_URL = String(process.env.FOUNDER_UAT_BASE_URL || "").replace(/\/$/, "");
const CUSTOMER_COOKIE = process.env.FOUNDER_UAT_CUSTOMER_COOKIE || "";
const ATLAS_MAKER_COOKIE = process.env.FOUNDER_UAT_ATLAS_MAKER_COOKIE || "";
const FOUNDER_COOKIE = process.env.FOUNDER_UAT_FOUNDER_COOKIE || "";
const CUSTOMER_ID = process.env.FOUNDER_UAT_CUSTOMER_ID || "";
const PET_ID = process.env.FOUNDER_UAT_PET_ID || "";
const SERVICE_ADDRESS = process.env.FOUNDER_UAT_SERVICE_ADDRESS || "";
const SERVICE_PINCODE = process.env.FOUNDER_UAT_SERVICE_PINCODE || "";
const TOTAL_AMOUNT = Number(process.env.FOUNDER_UAT_TOTAL_AMOUNT || 1899);
const DISCOUNT_AMOUNT = Number(process.env.FOUNDER_UAT_DISCOUNT_AMOUNT || 0);

const configured = [
  BASE_URL, CUSTOMER_COOKIE, ATLAS_MAKER_COOKIE, FOUNDER_COOKIE,
  CUSTOMER_ID, PET_ID, SERVICE_ADDRESS, SERVICE_PINCODE,
].every(Boolean);

test.describe("Founder UAT: Atlas recommendation -> human approval -> Grooming assignment", () => {
  test.skip(!configured, "Set FOUNDER_UAT_* hosted UAT credentials/fixture values to run this proof.");

  test("requires a distinct Atlas maker and Founder checker before partner assignment", async () => {
    expect(ATLAS_MAKER_COOKIE).not.toBe(FOUNDER_COOKIE);
    expect(Number.isFinite(TOTAL_AMOUNT) && TOTAL_AMOUNT > 0).toBeTruthy();
    expect(Number.isFinite(DISCOUNT_AMOUNT) && DISCOUNT_AMOUNT >= 0 && DISCOUNT_AMOUNT < TOTAL_AMOUNT).toBeTruthy();

    const customer = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { cookie: CUSTOMER_COOKIE, origin: BASE_URL },
    });
    const atlasMaker = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { cookie: ATLAS_MAKER_COOKIE, origin: BASE_URL },
    });
    const founder = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { cookie: FOUNDER_COOKIE, origin: BASE_URL },
    });

    try {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const groupId = `FOUNDER-UAT-${nonce}`;
      const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      start.setUTCHours(5, 30, 0, 0); // 11:00 IST, future date.
      const end = new Date(start.getTime() + 90 * 60 * 1000);
      const scheduledStart = start.toISOString();
      const scheduledEnd = end.toISOString();

      // 1) Customer creates the governed Grooming booking request. Admin-choice means
      // no provider is assigned until a human approves one of the ranked candidates.
      const requested = await customer.post("/api/uat-scheduling", {
        data: {
          clientRequestId: groupId,
          customerId: CUSTOMER_ID,
          petIds: [PET_ID],
          serviceCode: "grooming",
          serviceAddress: SERVICE_ADDRESS,
          servicePincode: SERVICE_PINCODE,
          scheduledStart,
          scheduledEnd,
          occurrences: 1,
          assignmentStrategy: "admin_choice",
        },
      });
      expect(requested.ok(), await requested.text()).toBeTruthy();
      const requestedBody = await requested.json();
      expect(requestedBody.data.status).toBe("awaiting_admin");
      expect(requestedBody.data.groupId).toBe(groupId);
      expect(Array.isArray(requestedBody.data.shortlist)).toBeTruthy();
      expect(requestedBody.data.shortlist.length).toBeGreaterThan(0);
      const suggestedProvider = requestedBody.data.shortlist[0].provider;
      expect(suggestedProvider?.id).toBeTruthy();

      // 2) Atlas records a recommendation only; it does not mutate provider assignment.
      const contextResponse = await atlasMaker.post("/api/ai-intelligence", {
        data: { action: "prepare_customer_context", customerId: CUSTOMER_ID },
      });
      expect(contextResponse.ok(), await contextResponse.text()).toBeTruthy();
      const context = (await contextResponse.json()).data;
      expect(context.id).toBeTruthy();

      const suggestionResponse = await atlasMaker.post("/api/ai-intelligence", {
        data: {
          action: "record_suggestion",
          contextId: context.id,
          type: "next_best_action",
          content: {
            groupId,
            serviceCode: "grooming",
            providerId: suggestedProvider.id,
            providerName: suggestedProvider.name,
            proposedDiscountAmount: DISCOUNT_AMOUNT,
            proposedFinalAmount: TOTAL_AMOUNT - DISCOUNT_AMOUNT,
            source: "founder_uat_atlas_recommendation",
          },
          confidence: 0.95,
          provider: "atlas",
          modelRef: "founder-uat-human-in-loop",
        },
      });
      expect(suggestionResponse.status(), await suggestionResponse.text()).toBe(201);
      const suggestion = (await suggestionResponse.json()).data;
      expect(suggestion.status).toBe("review_required");
      expect(suggestion.autonomousExecution).toBe(false);

      // 3) Founder is a separate checker and explicitly approves the AI proposal.
      const reviewResponse = await founder.post("/api/ai-intelligence", {
        data: {
          action: "review_suggestion",
          suggestionId: suggestion.id,
          decision: "approved",
          note: `Founder maker-checker approval for ${groupId}`,
        },
      });
      expect(reviewResponse.ok(), await reviewResponse.text()).toBeTruthy();
      expect((await reviewResponse.json()).data.status).toBe("approved");

      // 4) Only after approval does the Founder commit the ranked provider assignment.
      const assignResponse = await founder.post("/api/uat-scheduling", {
        data: {
          action: "assign",
          clientRequestId: `FOUNDER-CHECK-${nonce}`,
          groupId,
          customerId: CUSTOMER_ID,
          petIds: [PET_ID],
          serviceCode: "grooming",
          scheduledStart,
          scheduledEnd,
          providerId: suggestedProvider.id,
          reason: `Founder approved Atlas recommendation ${suggestion.id}`,
        },
      });
      expect(assignResponse.ok(), await assignResponse.text()).toBeTruthy();
      const assignment = (await assignResponse.json()).data;
      expect(assignment.status).toBe("assigned");
      expect(assignment.provider.id).toBe(suggestedProvider.id);

      // 5) The customer can now create the canonical Grooming booking against that exact assignment.
      const bookingResponse = await customer.post("/api/canonical-bookings", {
        data: {
          idempotencyKey: `founder-uat-book-${nonce}`,
          scheduleGroupId: groupId,
          customer: { id: CUSTOMER_ID, name: "Founder UAT Customer", primaryPhone: "+919999990001" },
          pets: [{ sourceId: PET_ID, name: "Founder UAT Pet", species: "dog" }],
          cityId: "blr",
          zoneId: "blr-east",
          serviceCode: "grooming",
          packageCode: "dog-basic",
          packageName: "Bath & Basic",
          scheduledStart,
          scheduledEnd,
          provider: { id: suggestedProvider.id, name: suggestedProvider.name, model: suggestedProvider.model },
          totalAmount: TOTAL_AMOUNT - DISCOUNT_AMOUNT,
          amountDueNow: TOTAL_AMOUNT - DISCOUNT_AMOUNT,
          payment: { method: "upi", mode: "prepaid", status: "created", detail: "Founder UAT human-in-loop proof" },
          pricing: { discount: DISCOUNT_AMOUNT },
        },
      });
      expect(bookingResponse.status(), await bookingResponse.text()).toBe(201);
      const booking = (await bookingResponse.json()).data;
      expect(booking.bookingId).toBeTruthy();
      expect(booking.scheduleGroupId).toBe(groupId);
      expect(booking.status).toMatch(/confirmed|payment_pending/);

      // Audit proof: the recommendation was made by one identity and reviewed by another.
      const auditResponse = await founder.get("/api/ai-intelligence");
      expect(auditResponse.ok(), await auditResponse.text()).toBeTruthy();
      const row = (await auditResponse.json()).data.suggestions.find((item: { id?: string }) => item.id === suggestion.id);
      expect(row).toBeTruthy();
      expect(row.status).toBe("approved");
      expect(row.requested_by).toBeTruthy();
      expect(row.reviewed_by).toBeTruthy();
      expect(row.requested_by).not.toBe(row.reviewed_by);
    } finally {
      await Promise.all([customer.dispose(), atlasMaker.dispose(), founder.dispose()]);
    }
  });
});
