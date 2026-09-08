import { expect, test } from "@playwright/test";
const phone = "9000000924";
async function sandboxLogin(page: import("@playwright/test").Page) {
  await page.goto("/mobile-app");
  const account = page.locator("nav").getByRole("button", { name: /account/i }).last();
  await account.click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "local sandbox OTP must be rendered").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("Browser E2E Customer");
  const verify = page.waitForResponse(response => response.url().includes("/api/customer-otp") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verify;
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}


test("customer notifications: authenticated empty inbox and recoverable UI delivery states", async ({ page }) => {
  await sandboxLogin(page);
  await page.getByRole("button", { name: /Notifications & reminders/ }).click();
  const dialog = page.getByRole("dialog", { name: "Notifications & reminders" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No support notifications yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close notifications" }).click();
  // UI fault injection only: delivery/auth/DB behavior is exercised by the connected route suite.
  let fail = true;
  await page.route("**/api/customer-notifications?**", route => fail
    ? route.fulfill({ status: 503, json: { error: "injected unavailable inbox" } })
    : route.fulfill({ json: { data: { items: [{ id: "UI-NOTICE", title: "Support update", message: "Your support case has passed its first-response target and is being escalated to our team.", bookingId: "UI-BOOKING", deliveredAt: 1788863400000 }], nextCursor: null } } }));
  await page.getByRole("button", { name: /Notifications & reminders/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Unable to load notifications");
  fail = false;
  await dialog.getByRole("button", { name: "Retry notifications" }).click();
  await expect(dialog.getByText("Booking: UI-BOOKING")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
