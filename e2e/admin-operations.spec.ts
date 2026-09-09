import { expect, test } from "@playwright/test";

test("admin: booking command center renders governed booking data", async ({ page, request }) => {
  const response = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
  expect(response?.status() ?? 500).toBeLessThan(500);
  await expect(page.getByRole("heading", { name: "Booking Command Center" })).toBeVisible();
  await expect(page.locator("body")).toContainText(/One place to control every booking/i);

  const api = await request.get("/api/booking-command-center");
  expect(api.ok(), `command center API must succeed (${api.status()})`).toBeTruthy();
  const payload = await api.json();
  expect(Array.isArray(payload?.bookings), "command center must return a booking array").toBeTruthy();
});
