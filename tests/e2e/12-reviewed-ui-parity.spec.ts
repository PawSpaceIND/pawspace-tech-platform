import { test, expect } from "@playwright/test";
// The reviewed illustrated UI must remain on top of the current checkout implementation.
// This drives the real local app, with no network interception, forged customer, or payment capture.
test("reviewed unified UI keeps both visual styles and all eight real service entries", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({});
  await page.context().clearCookies();
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
  // Professional is the reviewed default: icon cards deliberately hide the artwork.
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "professional");
  await expect(care.locator("article img").first()).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("customer-approved-professional-home.png"), fullPage: true });
  // Switch through the real preference controls before checking illustrated assets.
  await page.getByRole("button", { name: "Change PawSpace appearance" }).click();
  const appearance = page.getByRole("dialog", { name: "Make PawSpace yours." });
  await appearance.getByRole("radio", { name: /^Cartoon/ }).check();
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
