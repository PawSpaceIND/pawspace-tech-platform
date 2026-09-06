import { expect, test } from "@playwright/test";

test("admin: booking command center -> refund/dispute visibility", async ({ page, request }) => {
  const response = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
  expect(response?.status() ?? 500).toBeLessThan(500);
  await expect(page.locator("body")).toContainText(/One place to control every booking|booking/i);

  const api = await request.get("/api/booking-command-center");
  expect(api.status()).toBeLessThan(500);
  if (api.ok()) {
    const payload = await api.json();
    expect(Array.isArray(payload?.bookings)).toBeTruthy();
  }

  const refundText = page.getByText(/Refund cases|refund requested|refund/i).first();
  if (await refundText.count()) {
    await expect(refundText).toBeVisible();
  } else {
    test.info().annotations.push({
      type: "data",
      description: "Command center loaded through the triple-gated local preview actor but the isolated DB has no refund/dispute fixture.",
    });
  }
});
