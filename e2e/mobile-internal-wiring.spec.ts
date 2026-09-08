import { expect, test } from "@playwright/test";

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
