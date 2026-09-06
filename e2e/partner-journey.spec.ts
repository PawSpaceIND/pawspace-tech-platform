import { expect, test } from "@playwright/test";

const phone = process.env.PW_PARTNER_PHONE || "9000000912";

async function sandboxPartnerLogin(page: import("@playwright/test").Page) {
  await page.goto("/partner/onboarding");
  const phoneInput = page.getByPlaceholder("10-digit phone number");
  if (await phoneInput.isVisible().catch(() => false)) {
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
    if (await name.isVisible().catch(() => false)) await name.fill("Browser E2E Partner");

    const verifyOtp = page.waitForResponse(response => response.url().includes("/api/partner-otp") && response.request().method() === "POST" && response.ok());
    await page.getByRole("button", { name: "Verify & continue" }).click();
    const verifyResponse = await verifyOtp;

    const existing = await page.context().cookies();
    if (!existing.some(cookie => cookie.name === "pawspace_identity_session")) {
      const setCookie = verifyResponse.headers()["set-cookie"] || "";
      const token = setCookie.match(/(?:^|[,;]\s*)pawspace_identity_session=([^;]+)/)?.[1];
      expect(token, "partner OTP verify must issue the platform session cookie").toBeTruthy();
      await page.context().addCookies([{
        name: "pawspace_identity_session",
        value: decodeURIComponent(token!),
        url: new URL(page.url()).origin,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      }]);
      test.info().annotations.push({ type: "harness", description: "Local HTTP bridge applied to the real Secure cookie issued by partner OTP verification." });
    }
  }

  await expect.poll(async () => {
    const session = await page.context().request.get("/api/identity-session");
    if (!session.ok()) return null;
    const body = await session.json().catch(() => ({}));
    return body?.data?.subjectType === "provider" && body?.data?.subjectId ? body.data : null;
  }, { timeout: 15_000 }).not.toBeNull();
}

test("partner: verified login -> queue -> lifecycle surface", async ({ page }) => {
  await sandboxPartnerLogin(page);

  const response = await page.goto("/partner-app", { waitUntil: "domcontentloaded" });
  expect(response?.status() ?? 500).toBeLessThan(500);
  await expect(page.locator("body")).toContainText(/job|booking|queue|today|service/i);

  const lifecycle = page.getByRole("button", { name: /accept|on the way|arrived|start service|complete/i });
  if (await lifecycle.count()) {
    await expect(lifecycle.first()).toBeVisible();
  } else {
    test.info().annotations.push({
      type: "data",
      description: "Verified provider has no actionable seeded job; authenticated queue surface is still execution-verified.",
    });
  }
});
