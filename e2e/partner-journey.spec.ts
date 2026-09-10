import { expect, test } from "@playwright/test";

const phone = process.env.PW_PARTNER_PHONE || "9000000912";

async function sandboxPartnerLogin(page: import("@playwright/test").Page) {
  await page.goto("/partner/onboarding");
  const phoneInput = page.getByPlaceholder("10-digit phone number");
  await expect(phoneInput).toBeVisible();
  await phoneInput.fill(phone);
  const requestOtp = page.waitForResponse(response => response.url().includes("/api/partner-otp") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: "Send OTP" }).click();
  await requestOtp;

  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "local partner sandbox OTP must be rendered").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible()) await name.fill("Browser E2E Partner");

  const verifyOtp = page.waitForResponse(response => response.url().includes("/api/partner-otp") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verifyOtp;

  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch("/api/identity-session", { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.data?.subjectType === "provider" && body?.data?.subjectId ? body.data : null;
  }), { timeout: 15_000 }).not.toBeNull();
}

test("partner: verified OTP login -> authenticated queue surface", async ({ page }) => {
  await sandboxPartnerLogin(page);

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/identity-session", { cache: "no-store" });
    return response.ok ? response.json() : null;
  });
  expect(session?.data?.subjectType).toBe("provider");
  expect(String(session?.data?.subjectId || "")).not.toBe("");

  const response = await page.goto("/partner-app", { waitUntil: "domcontentloaded" });
  expect(response?.status() ?? 500).toBeLessThan(500);
  await expect(page.locator("body")).toContainText(/job|booking|queue|today|service/i);
});
