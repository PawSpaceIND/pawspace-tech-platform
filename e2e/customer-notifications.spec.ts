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

test('order inbox appears after sign-in without reload and pages older updates', async ({ page }) => {
  // UI contract fixtures only; gateway/database cursor coverage lives in the connected route suite.
  const item=(id:string)=>({id,service_code:'grooming',event_type:'completed',severity:'info',status:'unread',title:`Update ${id}`,body:'Fixture service update',created_at:100});
  await page.route('**/api/order-notifications?**',route=>{
    const older=new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({json:{data:{items:[item(older?'older':'newer')],unread:2,nextCursor:older?null:{at:100,id:'newer'}}}});
  });
  await sandboxLogin(page);
  await page.getByRole('button',{name:'2 unread order updates'}).click();
  const dialog=page.getByRole('dialog',{name:'PawSpace order notifications'});
  await expect(dialog.getByText('Update newer',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Older updates'}).click();
  await expect(dialog.getByText('Update older',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Older updates'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Newer updates'}).click();
  await expect(dialog.getByText('Update newer',{exact:true})).toBeVisible();
});
