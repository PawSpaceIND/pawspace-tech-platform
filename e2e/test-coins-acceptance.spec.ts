import { test, expect } from "@playwright/test";
const account = { customerId: "fixture-owner", name: "Test Customer", primaryPhone: "9000000001", email: "", cityId: "blr", addresses: [], pets: [] };
const programme = { id: "uat-referral-programme", name: "UAT Referral Programme", status: "paused", testOnly: true, friendDiscount: null, referrerReward: null, perReferrerMonthlyLimit: null, rewardValidityDays: null, eligibleServices: [], cityIds: [], rewardUseServices: [] };
const settings = { earnPercent: 10, expirySeconds: null, previewRupeesPerCoin: 1 };
const reward = { label: "TEST coins — no cash value", balance: 100, spendableCoins: 100, reversalDebt: 0, realMoneyValue: 0, expiredCoins: 0, expiryPendingCoins: 0, expiryConfigurationRequired: true, policy: settings, history: [], grants: [], services: [{ source: "booking", id: "TAXI-TEST-NEXT", serviceCode: "taxi", status: "confirmed" }] };
test("Account entry and existing paused referral are transparent", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/identity-session" ? { subjectType: "customer", subjectId: account.customerId } : path === "/api/customer-account" ? account : path === "/api/referral-governance" ? route.request().method() === "POST" ? { code: "FIXTURE-ONLY" } : { programmes: [programme], rewards: [] } : [];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.goto("/v2/account");
  await expect(page.getByRole("link", { name: "Open TEST coin preview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Referrals are not available yet" })).toBeVisible();
  await expect(page.getByText("TEST coins have no cash value and do not change your payments.", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: `../receipts/test-coins-account-${info.project.name}.png`, fullPage: true });
});
test("Taxi subsequent-booking TEST simulation keeps actual payable unchanged and reports expiry configuration", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  let redeemed = false;
  const preview = () => ({ bookingTotal: 100, currency: "INR", actualPayable: 100, simulatedDiscount: redeemed ? 80 : 0, simulatedPayable: redeemed ? 20 : 100, testCoinsRedeemed: redeemed ? 80 : 0, completed: false, refunded: false, status: "confirmed" });
  await page.route("**/api/v2/test-coins**", route => {
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    if (body?.action === "redeem") { expect(body.coins).toBe(80); expect(body.id).toBe("TAXI-TEST-NEXT"); redeemed = true; }
    const data = body?.action === "sync" ? reward : body?.action === "redeem" ? { ...reward, balance: 20, spendableCoins: 20, preview: preview() } : preview();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.goto("/v2/test-coins");
  await expect(page.getByRole("heading", { name: "100 TEST coins" })).toBeVisible();
  await expect(page.getByText("No expiry duration has been assumed.", { exact: false })).toBeVisible();
  await expect(page.getByText("10% of the eligible paid order value", { exact: false })).toBeVisible();
  await page.getByLabel("Your service booking").selectOption("booking:TAXI-TEST-NEXT");
  await expect(page.getByText("Your actual payment remains", { exact: false })).toBeVisible();
  await page.getByLabel("TEST coins to use").fill("80");
  const apply = page.getByRole("button", { name: "Apply TEST coins to simulation" });
  await expect(apply).toBeEnabled(); await apply.click();
  await expect(page.getByRole("heading", { name: "20 TEST coins" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Your payment amount is unchanged" })).toBeVisible();
  await expect(page.getByText("Your actual payment remains ₹100.00", { exact: false })).toBeVisible();
  await expect(apply).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `../receipts/test-coins-taxi-${info.project.name}.png`, fullPage: true });
});
test("expired grant state and disabled runtime never pretend real rewards are available", async ({ page, request }, info) => {
  const disabled = await request.get("/api/v2/test-coins");
  expect([401, 403, 404]).toContain(disabled.status());
  await page.route("**/api/v2/test-coins**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { ...reward, balance: 0, spendableCoins: 0, expiredCoins: 10, grants: [{ grant_id: "expired-fixture", source_id: "PRIOR-TAXI", remaining: 10, expires_at: 1, eligible_amount: 100, earn_percent: 10 }] } }) }));
  await page.goto("/v2/test-coins");
  await expect(page.getByText("10 unused TEST coins have expired.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply TEST coins to simulation" })).toBeDisabled();
  await page.screenshot({ path: `../receipts/test-coins-expired-${info.project.name}.png`, fullPage: true });
});
