import { test, expect } from "@playwright/test";

/*
 * Customer journey: discovery -> service selection -> booking surface -> customer-owned account.
 * Driven as the SEEDED customer identity (app_users role_code='customer'), not the preview superuser.
 */
const AS_CUSTOMER = { "oai-authenticated-user-email": "e2e.customer@pawspace.test" };
test.use({ extraHTTPHeaders: AS_CUSTOMER });

test("the storefront renders real content, not a blank or error page", async ({ page }) => {
  await page.setExtraHTTPHeaders({});
  const res = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Grooming that comes home/i })).toBeVisible();
  await expect(page.getByText(/Bengaluru/i).filter({ visible: true }).first()).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body.replace(/\s+/g, " ").trim().length, "storefront must render substantive content").toBeGreaterThan(200);
  expect(body).not.toMatch(/Application error|Something went wrong|Unhandled Runtime Error/i);
});

test("the customer can reach the canonical grooming service and see a bookable surface", async ({ page }) => {
  const response = await page.goto("/services/grooming", { waitUntil: "domcontentloaded" });
  expect(response?.status(), "canonical grooming route must resolve").toBe(200);
  await expect(page.locator("body")).toContainText(/groom|package|price|₹|book/i);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body).toMatch(/groom|package|price|₹|book/i);
});

test("the mobile app surface renders (was a blank screen in the 2026-09-05 audit)", async ({ page }) => {
  const res = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("navigation", { name: "Customer navigation" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async()=>{
    const text=(await page.locator("body").innerText()).replace(/\s+/g," ").trim();
    return text.length;
  },{message:"/mobile-app must not render blank",timeout:15_000}).toBeGreaterThan(150);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
});

test("the customer can read their own governed account surface", async ({ request }) => {
  const res = await request.get("/api/customer-account?customerId=E2E-CUS-UI-001");
  expect(res.ok(), `own customer account must succeed (${res.status()})`).toBeTruthy();
  const body = await res.json();
  expect(body?.source).toBe("canonical_customer_account");
  expect(body?.data?.customerId).toBe("E2E-CUS-UI-001");
  expect(Array.isArray(body?.data?.pets)).toBeTruthy();
  expect(body.data.pets.some((pet: { id?: string }) => pet.id === "E2E-PET-UI-001")).toBeTruthy();
});

test("customer discovery and app surfaces never expose sandbox/prototype payment wording", async ({ page }) => {
  const findings: string[] = [];
  for (const path of ["/discover", "/mobile-app"]) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(response?.status() ?? 500, `${path} must load`).toBeLessThan(400);
    await page.waitForTimeout(300);
    const body = await page.locator("body").innerText();
    const hits = body.match(/\b(sandbox|prototype)\b/gi) ?? [];
    if (hits.length) findings.push(`${path}: ${[...new Set(hits.map(hit => hit.toLowerCase()))].join(",")}`);
  }
  expect(findings, "customer discovery/app copy must not disclose sandbox or prototype internals").toEqual([]);
});

// Physical browser checks on the built app. No intercepted responses or SDK doubles.
// This checks navigation and the real unconfigured-checkout refusal, NOT a gateway payment.
test("customer navigation and billing controls have physical 44px targets and recover from unconfigured checkout", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({});
  await page.context().clearCookies();
  const measurements: Array<Record<string, unknown>> = [];
  async function target(control: import("@playwright/test").Locator, label: string) {
    await expect(control, label).toBeVisible();
    await expect(control, label).toBeEnabled();
    await control.scrollIntoViewIfNeeded();
    await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "center" }));
    const box = await control.boundingBox();
    expect(box, `${label}: a physical rectangle is required`).not.toBeNull();
    const hit = await control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { unobstructed: !!top && (top === element || element.contains(top)), pointerEvents: getComputedStyle(element).pointerEvents };
    });
    measurements.push({ label, width: box!.width, height: box!.height, ...hit });
    console.log(`[PAWSPACE-UX] ${JSON.stringify(measurements.at(-1))}`);
    expect.soft(box!.width, `${label}: minimum width`).toBeGreaterThanOrEqual(44);
    expect.soft(box!.height, `${label}: minimum height`).toBeGreaterThanOrEqual(44);
    expect.soft(hit.unobstructed, `${label}: center must receive pointer events`).toBe(true);
    await control.click({ trial: true });
  }
  try {
    const response = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const nav = page.getByRole("navigation", { name: "Customer navigation" });
    const surfaces = [["Home", /Good morning,/], ["Book", /^Book Grooming$/], ["Activity", /^Your activity$/],
      ["My Pets", /^Your pets$/], ["Account", /^My PawSpace$/]] as const;
    for (const [name, heading] of surfaces) {
      const button = nav.getByRole("button", { name: new RegExp(name === "Book" ? "Book$" : name + "$", "i") });
      await target(button, `navigation:${name}`);
      await button.click();
      // The discovery shell intentionally hides its legacy greeting header via :has([data-discovery]).
      // Verify the visible functional home region instead; all other tabs retain their own heading.
      if (name === "Home") await expect(page.getByRole("region", { name: "Care services", exact: true })).toBeVisible();
      else await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath("customer-ux-guest-navigation.png"), fullPage: true });

    // Normal local sandbox OTP exchange, not a forged browser customer or bypassed session.
    await expect(page.getByPlaceholder("10-digit phone number")).toBeEnabled();
    await page.getByPlaceholder("10-digit phone number").fill("9800000111");
    const send = page.getByRole("button", { name: "Send OTP", exact: true });
    await target(send, "login:Send OTP");
    await send.click();
    const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
    await expect(sandbox).toBeVisible();
    const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    await page.getByPlaceholder("6-digit code").fill(code!);
    const name = page.getByPlaceholder("Your name (first time only)");
    if (await name.isVisible()) await name.fill("E2E UI Customer");
    const verify = page.getByRole("button", { name: "Verify & continue", exact: true });
    await target(verify, "login:Verify & continue");
    await verify.click();
    await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
    const account = await page.evaluate(async () => {
      const response = await fetch("/api/customer-account", { cache: "no-store" });
      return { status: response.status, body: await response.json() };
    });
    expect(account.status).toBe(200);
    expect(account.body.data.customerId).toBe("E2E-CUS-UI-001");

    for (const title of ["Notifications & reminders", "Offers & PawPoints", "Privacy & security", "Payments & invoice summaries"]) {
      const summary = page.locator("summary").filter({ hasText: title });
      await target(summary, `account:${title}`);
      await summary.click();
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      if (title !== "Payments & invoice summaries") await summary.click();
    }
    const billing = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "Payments & invoice summaries" }) });
    const pay = billing.getByRole("button", { name: /^(Review & pay|Check balance) \(test\)$/ }).first();
    await target(pay, "billing:checkout");
    await target(billing.getByRole("button", { name: "Billing support", exact: true }), "billing:support");
    // No external Razorpay credentials are provisioned in the hardened local UI runner.
    // Assert its real 503 refusal and visible retry, never count it as captured/paid.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/customer-checkout" && response.request().method() === "POST");
      await pay.click();
      const result = await reply;
      expect(result.status()).toBe(503);
      const body = await result.json();
      expect(body.error).toMatch(/not enabled for this environment|not configured/);
      await expect(billing.getByRole("alert")).toContainText(body.error);
      await expect(pay).toBeEnabled();
      await expect(billing.getByText("Payment in progress…", { exact: true })).toHaveCount(0);
      console.log(`[PAWSPACE-UX] checkout_attempt=${attempt} http=503 configuration=BLOCKED capture=NOT_RUN`);
    }
    await page.screenshot({ path: testInfo.outputPath("customer-ux-checkout-refusal.png"), fullPage: true });
    const refresh = billing.getByRole("button", { name: "Refresh billing", exact: true });
    await target(refresh, "billing:refresh");
    await refresh.click();
    await expect(pay).toBeVisible();
    await expect(billing.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("customer-ux-billing-recovered.png"), fullPage: true });
  } finally {
    await testInfo.attach("customer-ux-target-measurements", { body: JSON.stringify({ project: testInfo.project.name,
      scope: "navigation-login-account-billing; not exhaustive service-flow or provider E2E", measurements }, null, 2), contentType: "application/json" });
  }
});

// The reviewed illustrated UI must remain on top of the current checkout implementation.
// This drives the real local app, with no network interception, forged customer, or payment capture.
test("reviewed unified UI keeps both visual styles and all eight real service entries", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({});
  await page.context().clearCookies();
  await page.addInitScript(() => {
    localStorage.setItem("pawspace.visual-style", "professional");
  });
  const response = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  const home = page.locator('[data-home-design="pawspace-prototype-converged"]');
  await expect(home).toBeVisible({ timeout: 20_000 });
  await expect(home.getByRole("heading", { name: /Welcome to your.*Petter half/ })).toBeVisible();
  await expect(page.locator('[data-home-design="option-5-premium-visual"]')).toHaveCount(0);
  await expect(home.locator('img[src="/assets/pawspace-icon.jpeg"]')).toBeVisible();
  const care = page.getByRole("region", { name: "Care services", exact: true });
  await expect(care.getByRole("heading", { name: "Care for every little need" })).toBeVisible();
  const names = ["Grooming", "Training", "Boarding", "Pet Sitting", "Pet Taxi", "Dog Walking", "Fresh Food", "Relocation"];
  await expect(care.getByRole("button")).toHaveCount(names.length);
  // Force the reviewed professional baseline: icon cards deliberately hide the artwork.
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "professional");
  await expect(care.locator("article img").first()).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("customer-approved-professional-home.png"), fullPage: true });
  // Switch through the real preference controls before checking illustrated assets.
  await page.getByRole("button", { name: "Change PawSpace appearance" }).click();
  const appearance = page.getByRole("dialog", { name: "Make PawSpace yours." });
  await appearance.getByRole("radio", { name: /^Illustrated mascots/ }).check();
  await appearance.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "cartoon");
  const measurements = [];
  for (const name of names) {
    const card = care.getByRole("button", { name: new RegExp(name, "i") });
    await expect(card).toBeEnabled();
    await card.scrollIntoViewIfNeeded();
    await card.click({ trial: true });
    const box = await card.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const image = card.locator("..").locator("img");
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    measurements.push({ name, width: box!.width, height: box!.height, image: await image.getAttribute("src") });
  }
  await home.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("customer-approved-unified-home.png"), fullPage: true });
  const search = home.getByRole("textbox", { name: "Search PawSpace services" });
  await search.fill("food");
  await expect(care.getByRole("button")).toHaveCount(1);
  await expect(care.getByRole("button", { name: /Fresh Food/ })).toBeVisible();
  await search.fill("");
  await expect(care.getByRole("button")).toHaveCount(8);
  await home.getByRole("button", { name: "Choose your service location", exact: true }).click();
  const location = page.getByRole("dialog", { name: "Choose your service area" });
  await expect(location).toBeVisible();
  await location.getByRole("button", { name: "Close location", exact: true }).click();
  await expect(location).toBeHidden();
  const nav = page.getByRole("navigation", { name: "Customer navigation" });
  for (const name of names) {
    await care.getByRole("button", { name: new RegExp(name, "i") }).click();
    await expect(page.getByRole("heading", { name: `Book ${name}`, exact: true })).toBeVisible();
    if (name === "Grooming") {
      const hero = page.getByRole("region", { name: "Grooming overview", exact: true });
      await expect(hero).toBeVisible();
      await expect(hero).toContainText("AI illustration");
      await expect.poll(() => hero.locator("img").evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("customer-approved-unified-grooming.png"), fullPage: true });
    } else {
      await expect(page.getByRole("button", { name: "Send OTP", exact: true })).toBeVisible();
    }
    await nav.getByRole("button", { name: /Home$/i }).click();
    await expect(home).toBeVisible();
  }
  await page.getByRole("button", { name: "Change PawSpace appearance" }).click();
  await appearance.getByRole("radio", { name: /^Professional/ }).check();
  await appearance.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "professional");
  await page.reload();
  await expect(home).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "professional");
  await expect(care.getByRole("button")).toHaveCount(8);
  await testInfo.attach("approved-unified-ui-controls", { body: JSON.stringify({ project: testInfo.project.name,
    uiSource: "97d006a54c6661d21bb455bf8968a97739430c67", scope: "guest service entry, artwork, search, location and navigation; not payment capture", measurements }, null, 2), contentType: "application/json" });
});
