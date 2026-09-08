import { expect, test } from "@playwright/test";
import { runGroomingDemo } from "../helpers/correlated-grooming";

test("correlated journey: customer reserves/books -> assigned provider completes -> admin sees balanced completion finance", async ({ page, baseURL }) => {
  expect(baseURL).toBeTruthy();
  await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": "e2e.customer@pawspace.test" });
  const home = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
  expect(home?.status() ?? 500).toBeLessThan(500);
  await expect(page.locator("body")).toContainText(/PawSpace|Everything they need|Care services/i);
  const suffix = `${Date.now()}-${test.info().project.name}`.replace(/[^a-zA-Z0-9-]/g, "");
  const result = await runGroomingDemo(baseURL!, suffix, test.info().project.name === "mobile-chromium" ? 6 : 5);
  await test.info().attach("connected-demo", {body: JSON.stringify(result, null, 2), contentType: "application/json"});
  await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": "e2e.admin@pawspace.test" });
  const adminUi = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
  expect(adminUi?.status() ?? 500).toBeLessThan(500);
  await expect(page.locator("body")).toContainText(/booking/i);
});
