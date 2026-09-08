import { expect, test } from "@playwright/test";

test("human UAT partner app makes photo deferral clear and sends no upload", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST") writes.push(request.url()); });
  await page.route("**/api/identity-session", route => route.fulfill({ json: { data: { subjectType: "provider", subjectId: "provider-uat", roleCode: "provider" } } }));
  await page.route("**/api/partner-grooming-jobs?*", route => route.fulfill({ json: { jobs: [{ bookingId: "booking-uat", workOrderId: "wo-uat", providerId: "provider-uat", providerName: "Demo partner", providerModel: "employee", status: "in_service", workOrderStatus: "in_service", packageName: "At-home grooming", zoneId: "Demo zone", scheduledStart: "2026-10-01T10:00:00Z", scheduledEnd: "2026-10-01T11:00:00Z", totalAmount: 999, customer: { id: "customer-uat", name: "Demo parent", maskedPhone: "******1234" }, pets: [{ id: "pet-uat", name: "Milo", species: "dog", breed: "Golden Retriever", vaccinationStatus: "verified" }], payment: { mode: "pay_now", status: "captured" }, proof: null, invoice: null }] } }));
  await page.route("**/api/grooming-payment-sandbox?*", route => route.fulfill({ json: { data: null } }));
  await page.goto("/partner-app");
  await expect(page.getByText("Internal human test · photos deferred")).toBeVisible();
  await expect(page.getByRole("button", { name: "Photo proof · later test round" })).toBeDisabled();
  await page.getByRole("button", { name: "View job", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My jobs" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Photo proof · later test round" })).toBeDisabled();
  expect(writes.filter(url => /service-media|grooming-lifecycle/.test(url))).toEqual([]);
});

test("internal photo review blocks approval until the private image loads", async ({ page }) => {
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/service-media?*", route => route.fulfill({ json: { assets: [{ id: "photo-a", purpose: "grooming_before", access_status: "quarantined", proofReady: false }] } }));
  await page.route("**/api/internal-service-media**", route => {
    const request = route.request();
    if (request.method() === "POST") {
      submitted.push(request.postDataJSON());
      return route.fulfill({ json: { internalTest: true } });
    }
    if (request.url().includes("mediaId=")) return route.fulfill({ status: 404 });
    return route.fulfill({ json: { internalTest: true, privateStorage: true } });
  });
  await page.goto("/team/operations/media-review?bookingId=internal-booking");
  await page.getByLabel("Review reason").fill("Photo did not load for review");
  await expect(page.getByRole("button", { name: "Approve for UAT" })).toBeDisabled();
  await page.getByRole("button", { name: "Reject photo" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ mediaId: "photo-a", decision: "rejected" });
});

test("internal walk uses the selected active session and sends no sample IDs", async ({ page }) => {
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/walking-lifecycle?*", route => route.fulfill({ json: { data: [{ id: "internal-booking", provider_id: "assigned-partner", sessions: [{ id: "active-session", status: "in_progress" }] }] } }));
  await page.route("**/api/walking-proof**", route => {
    if (route.request().method() === "POST") {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({ json: { data: { status: "recorded" }, sandboxOnly: true } });
    }
    return route.fulfill({ json: { data: { bookingId: "internal-booking", providerId: "assigned-partner", sandboxOnly: true, routeSamples: [], media: [], incidents: [] } } });
  });
  await page.goto("/walker/proof?bookingId=internal-booking&sessionId=active-session");
  await page.getByRole("button", { name: "Transmit Sandbox Route Sample", exact: false }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({ bookingId: "internal-booking", sessionId: "active-session", action: "record_location_sample" });
  expect(JSON.stringify(submitted)).not.toContain("UAT-WALK-SAMPLE");
});

test("internal walk denies location controls for an inactive or unauthorized session", async ({ page }) => {
  await page.route("**/api/walking-lifecycle?*", route => route.fulfill({ json: { data: [{ id: "internal-booking", provider_id: "assigned-partner", sessions: [{ id: "done-session", status: "completed" }] }] } }));
  await page.route("**/api/walking-proof**", route => route.fulfill({ status: 403, json: { error: "internal permission details must not leak into the location panel" } }));
  await page.goto("/walker/proof?bookingId=internal-booking&sessionId=done-session");
  await expect(page.getByRole("button", { name: "Check active walk again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Live GPS Tracking", exact: false })).toHaveCount(0);
  await expect(page.getByText("internal permission details must not leak into the location panel")).toHaveCount(0);
});
