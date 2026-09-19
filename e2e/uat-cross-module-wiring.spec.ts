import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const ADDRESS =
  "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";
const phone = `6${String(Date.now()).slice(-9)}`;
const PROVIDER_PHONES: Record<string, string> = {
  uatcap_groom_ft: "9000000901", uatcap_groom_cm: "9000000902", uatcap_groom_east: "9000000903",
  uatcap_groom_south: "9000000904", uatcap_groom_north: "9000000905", uatcap_groom_west: "9000000906", uatcap_groom_central: "9000000907",
  uatcap_groom_east_2: "9000000911", uatcap_groom_east_3: "9000000912", uatcap_groom_south_2: "9000000913", uatcap_groom_south_3: "9000000914",
  uatcap_groom_north_2: "9000000915", uatcap_groom_north_3: "9000000916", uatcap_groom_west_2: "9000000917", uatcap_groom_west_3: "9000000918",
  uatcap_groom_central_2: "9000000919", uatcap_groom_central_3: "9000000920",
  uatcap_groom_east_4: "9000000921", uatcap_groom_east_5: "9000000922", uatcap_groom_south_4: "9000000923", uatcap_groom_south_5: "9000000924",
  uatcap_groom_north_4: "9000000925", uatcap_groom_north_5: "9000000926", uatcap_groom_west_4: "9000000927", uatcap_groom_west_5: "9000000928",
  uatcap_groom_central_4: "9000000929", uatcap_groom_central_5: "9000000930",
  uatcap_groom_east_6: "9000000951", uatcap_groom_east_7: "9000000952", uatcap_groom_east_8: "9000000953", uatcap_groom_south_6: "9000000954",
  uatcap_groom_south_7: "9000000955", uatcap_groom_south_8: "9000000956", uatcap_groom_north_6: "9000000957", uatcap_groom_north_7: "9000000958",
  uatcap_groom_north_8: "9000000959", uatcap_groom_west_6: "9000000960", uatcap_groom_west_7: "9000000961", uatcap_groom_west_8: "9000000962",
  uatcap_groom_central_6: "9000000963", uatcap_groom_central_7: "9000000964", uatcap_groom_central_8: "9000000965",
};

async function assignedPartnerPage(browser: Browser, baseURL: string, providerId: string) {
  const providerPhone = PROVIDER_PHONES[providerId];
  expect(providerPhone, `No seeded OTP phone for assigned provider ${providerId}`).toBeTruthy();
  const context: BrowserContext = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/partner/onboarding");
  await page.getByPlaceholder("10-digit phone number").fill(providerPhone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible({ timeout: 20_000 });
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const verify = page.waitForResponse(r => r.url().includes("/api/partner-otp") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  const response = await verify;
  const body = await response.json().catch(() => ({})) as { data?: { providerId?: string } };
  expect(response.status()).toBe(200);
  expect(body.data?.providerId).toBe(providerId);
  return { context, page };
}

async function sandboxLogin(page: Page) {
  await page.goto("/mobile-app");
  await page
    .locator("nav")
    .getByRole("button", { name: /account/i })
    .last()
    .click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false))
    await name.fill("Cross Module Wiring UAT");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensurePet(page: Page) {
  const account = await (
    await page.context().request.get("/api/customer-account")
  ).json();
  if (account.data?.pets?.length) return account.data.customerId as string;
  const created = await page.context().request.post("/api/customer-account", {
    data: {
      action: "upsert_pet",
      idempotencyKey: `cross-module:${account.data.customerId}`,
      pet: {
        name: "Buddy",
        species: "dog",
        breed: "Labrador Retriever",
        vaccinationStatus: "not_provided",
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  return account.data.customerId as string;
}

async function staffPage(browser: Browser, baseURL: string, identity: RegExp) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/staging-login");
  await page
    .getByPlaceholder("shared UAT access code")
    .fill(process.env.PW_STAFF_UAT_ACCESS_CODE || "pawspace-e2e-access-only");
  const signed = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/staging-login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: identity }).click();
  expect((await signed).status()).toBe(200);
  await page.waitForURL("**/me");
  return { context, page };
}

test("grooming sandbox checkout propagates to Admin and CRM", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const baseURL =
    process.env.PW_BASE_URL ||
    `http://localhost:${process.env.PW_PORT || "4185"}`;
  const founder = await staffPage(browser, baseURL, /Founder \(full access\)/);
  let partner: Awaited<ReturnType<typeof assignedPartnerPage>> | null = null;
  let assignedProviderId = "";
  page.on("response", async (response) => {
    if (
      response.url().includes("/api/uat-scheduling") &&
      response.request().method() === "POST"
    ) {
      const text = await response.text().catch(() => "<unreadable>");
      console.log("UAT-SCHEDULING", response.status(), text);
      try {
        const body = JSON.parse(text) as { data?: { status?: string; provider?: { id?: string } } };
        if (response.status() === 200 && body.data?.status === "assigned" && body.data.provider?.id) {
          assignedProviderId = body.data.provider.id;
        }
      } catch {}
    }
  });
  try {
    const serviceDate = process.env.PW_UAT_SERVICE_DATE!;
    const serviceAsOf = Date.parse(`${serviceDate}T12:00:00+05:30`);
    const overviewPath = `/api/operations-overview?asOf=${serviceAsOf}`;
    const beforeResponse = await founder.page.request.get(overviewPath);
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);
    const before = await beforeResponse.json();
    const beforeCount = Number(before.data.metrics.bookingsToday);

    await page.route("**/api/address-autocomplete?*", async (route) => {
      const mode = new URL(route.request().url()).searchParams.get("mode");
      if (mode === "search")
        return route.fulfill({
          json: {
            data: {
              status: "configured",
              suggestions: [
                {
                  placeId: "cross-module-doorstep",
                  mainText: "42, Indiranagar Double Road",
                  secondaryText: "Bengaluru 560038",
                  fullText: ADDRESS,
                },
              ],
            },
          },
        });
      return route.fulfill({
        json: {
          data: {
            status: "configured",
            address: ADDRESS,
            latitude: 12.9783692,
            longitude: 77.6408356,
          },
        },
      });
    });

    await sandboxLogin(page);
    const customerId = await ensurePet(page);
    await page.goto("/mobile-app");
    await page
      .locator("nav")
      .getByRole("button", { name: /home/i })
      .last()
      .click();
    const grooming = page
      .getByRole("region", { name: "Care services" })
      .getByRole("article")
      .filter({ hasText: "Grooming" })
      .first();
    const location = page.getByRole("button", {
      name: "Choose your service location",
    });
    if (await location.isVisible().catch(() => false)) {
      await location.click();
      await page
        .getByRole("dialog", { name: "Choose your service area" })
        .getByRole("button", { name: "Browse without location" })
        .click();
    }
    await grooming.getByRole("button", { name: /book now/i }).click();
    await page.getByRole("button", { name: /Choose a package/i }).click();
    await page
      .getByRole("button", { name: "Choose address and requested time" })
      .click();
    const line1 = page.locator("#grooming-address-line-1");
    await expect(line1, "Address Line 1 (Google Places) input present").toBeVisible();
    await line1.fill("42, Indiranagar Double Road");
    const suggestions = page.getByRole("region", { name: "Google address suggestions" });
    await expect(suggestions).toBeVisible({ timeout: 20_000 });
    await suggestions.getByRole("button").first().click();
    await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible({ timeout: 20_000 });

    const serviceDay = Number(serviceDate.slice(-2));
    const serviceMonth = new Intl.DateTimeFormat("en-IN", {
      month: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(`${serviceDate}T12:00:00+05:30`));
    await page
      .getByRole("button", {
        name: new RegExp(`${serviceDay} ${serviceMonth}$`),
      })
      .click();
    await page.getByRole("button", { name: /^3:00–5:00 PM/ }).click();
    await page.getByRole("button", { name: "Review booking" }).click();
    await page.getByRole("button", { name: /^Pay after service/ }).click();
    const created = page.waitForResponse(
      (r) =>
        r.url().includes("/api/canonical-bookings") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirm booking" }).click();
    const bookingResponse = await created;
    expect(bookingResponse.status(), await bookingResponse.text()).toBe(201);
    const booking = await bookingResponse.json();
    const bookingId = String(booking.data?.bookingId || "");
    expect(bookingId).toMatch(/^PS-/);
    await expect(
      page.getByText("Pay after service", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(
      page
        .getByText(/booking confirmed|confirmed and your groomer is reserved/i)
        .first(),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`customer-${bookingId}.png`),
      fullPage: true,
    });

    expect(assignedProviderId, "scheduler must expose the assigned provider ID").toBeTruthy();
    partner = await assignedPartnerPage(browser, baseURL, assignedProviderId);
    await partner.page.goto("/partner/jobs");
    await expect(
      partner.page.locator("body"),
      `PARTNER_DISCONNECTION: assigned provider ${assignedProviderId} job feed does not expose the canonical booking ID`,
    ).toContainText(bookingId, { timeout: 30_000 });
    await partner.page.screenshot({
      path: test.info().outputPath(`partner-${bookingId}.png`),
      fullPage: true,
    });

    await founder.page.goto("/admin");
    await expect(
      founder.page.getByText("Today’s bookings", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          Number(
            (await (await founder.page.request.get(overviewPath)).json()).data
              .metrics.bookingsToday,
          ),
        {
          message:
            "ADMIN_DISCONNECTION: canonical booking did not increment operations overview",
        },
      )
      .toBe(beforeCount + 1);

    await expect(
      founder.page.locator("body"),
      "ADMIN_DISCONNECTION: Admin does not expose the canonical booking ID",
    ).toContainText(bookingId);
    await founder.page.screenshot({
      path: test.info().outputPath(`founder-admin-${bookingId}.png`),
      fullPage: true,
    });

    await founder.page.goto("/crm");
    const crmResponse = await founder.page.request.get("/api/crm");
    expect(crmResponse.status(), await crmResponse.text()).toBe(200);
    const crm = await crmResponse.json();
    const contact = (crm.contacts || []).find(
      (row: { id?: string }) => row.id === customerId,
    );
    expect(
      contact,
      `CRM_DISCONNECTION: customer ${customerId} from canonical checkout is not projected into crm_contacts`,
    ).toBeTruthy();
    await expect(
      founder.page.locator("body"),
      "CRM_LEDGER_DISCONNECTION: CRM customer ledger does not expose the canonical booking ID",
    ).toContainText(bookingId);
    await founder.page.screenshot({
      path: test.info().outputPath(`founder-crm-${bookingId}.png`),
      fullPage: true,
    });
    console.log(`CROSS_MODULE_BOOKING_ID=${bookingId}`);
  } finally {
    if (partner) await partner.context.close().catch(() => {});
    await founder.context.close().catch(() => {});
  }
});
