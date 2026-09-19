import { expect, test, type Browser, type Page } from "@playwright/test";

const ADDRESS =
  "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";
const phone = `6${String(Date.now()).slice(-9)}`;

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
  test.setTimeout(120_000);
  const baseURL =
    process.env.PW_BASE_URL ||
    `http://localhost:${process.env.PW_PORT || "4185"}`;
  const founder = await staffPage(browser, baseURL, /Founder \(full access\)/);
  const partner = await staffPage(
    browser,
    baseURL,
    /Employee — groomer \(self-service\)/,
  );
  page.on("response", async (response) => {
    if (
      response.url().includes("/api/uat-scheduling") &&
      response.request().method() === "POST"
    ) {
      console.log(
        "UAT-SCHEDULING",
        response.status(),
        await response.text().catch(() => "<unreadable>"),
      );
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

    await partner.page.goto("/partner/jobs");
    await expect(
      partner.page.locator("body"),
      "PARTNER_DISCONNECTION: Asha job feed does not expose the canonical booking ID",
    ).toContainText(bookingId);
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
    await partner.context.close();
    await founder.context.close();
  }
});
