import { expect, test, type Page } from '@playwright/test';

async function visibleInFrames(page: Page, selectors: string[]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const frame of page.frames()) for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`No visible Razorpay field found for ${selectors.join(', ')}`);
}
async function visibleButton(page: Page, pattern: RegExp) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const frame of page.frames()) {
      const button = frame.getByRole('button', { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) return button;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`No visible Razorpay button found for ${pattern}`);
}
async function login(page: Page) {
  page.setDefaultTimeout(15000);
  await page.goto('/');
  const login = page.getByRole('button', { name: /login/i }).or(page.getByRole('link', { name: /login/i }));
  await login.first().click();
  const dialog = page.getByRole('dialog', { name: /customer login/i });
  await dialog.getByLabel('Phone number').fill('9876543210');
  await dialog.getByRole('button', { name: /send otp/i }).click();
  const otpInput = dialog.getByLabel('OTP code');
  await expect(otpInput).toBeVisible();
  const otpText = await dialog.innerText(), code = (otpText.match(/\b(\d{6})\b/) || [])[1];
  expect(code, otpText).toMatch(/^\d{6}$/);
  await otpInput.fill(code);
  await dialog.getByRole('button', { name: /verify & continue/i }).click();
  await expect(page.getByRole('heading', { name: /who needs grooming/i })).toBeVisible();
}
async function ensureDog(page: Page) {
  await page.getByRole('button', { name: 'Dog', exact: true }).click();
  const selectableDogPets = page.locator('button[aria-pressed]:not([aria-disabled="true"])');
  if (await selectableDogPets.count()) return;
  await page.getByRole('button', { name: /add or edit pet details/i }).click();
  await page.getByRole('button', { name: /add pet/i }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mission Dog');
  await page.getByLabel('Species', { exact: true }).selectOption('dog');
  await page.getByLabel('Breed', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Age', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Weight', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Temperament', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Vaccinated?', { exact: true }).selectOption('no');
  await page.getByRole('button', { name: 'Add pet', exact: true }).click();
  await expect(selectableDogPets.first()).toBeVisible();
}

test('Mission 02: canonical booking plus real Razorpay sandbox card capture', async ({ page }) => {
  await login(page);
  await ensureDog(page);
  const pet = page.locator('button[aria-pressed]:not([aria-disabled="true"])').first();
  if ((await pet.getAttribute('aria-pressed')) !== 'true') await pet.click();
  await page.getByRole('button', { name: /choose a package/i }).click();
  const bathBasic = page.getByRole('button', { name: /Bath & Basic/ }).first();
  await bathBasic.click();
  await expect(bathBasic).toContainText(/1,899/);
  await page.getByRole('button', { name: /choose address and requested time/i }).click();
  await page.getByLabel('Complete doorstep address').fill('21 PawSpace Test Street, Koramangala');
  await page.getByPlaceholder('e.g., 560034').fill('560034');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText(/Available/).first()).toBeVisible();
  await page.getByRole('button', { name: /11:00 AM–1:00 PM/ }).click();
  await page.getByRole('button', { name: /review booking/i }).click();
  await page.getByRole('button', { name: /Pay online/ }).click();

  const completion = page.waitForResponse(async response => {
    if (!response.url().includes('/api/payment-order') || response.request().method() !== 'POST') return false;
    try { return (await response.request().postDataJSON()).action === 'complete'; } catch { return false; }
  });
  const providerProfile = page.waitForResponse(response => response.url().includes('/api/provider-public-profile')).catch(() => null);
  await page.getByRole('button', { name: /create canonical uat booking|confirm booking/i }).click();

  await (await visibleButton(page, /card/i)).click().catch(() => {});
  await (await visibleInFrames(page, ['input[name="card[number]"]', 'input[placeholder*="card" i]', 'input[aria-label*="card number" i]'])).fill('5105105105105100');
  await (await visibleInFrames(page, ['input[name="card[expiry]"]', 'input[placeholder*="MM" i]', 'input[aria-label*="expiry" i]'])).fill('1230');
  await (await visibleInFrames(page, ['input[name="card[cvv]"]', 'input[placeholder*="CVV" i]', 'input[aria-label*="CVV" i]'])).fill('123');
  await (await visibleButton(page, /pay/i)).click();

  const success = await visibleButton(page, /success/i).catch(() => null);
  if (success) await success.click();
  else {
    const otp = await visibleInFrames(page, ['input[placeholder*="OTP" i]', 'input[name*="otp" i]', 'input[aria-label*="OTP" i]']);
    await otp.fill('1234');
    await (await visibleButton(page, /submit|verify|continue/i)).click();
  }

  const response = await completion, payload = await response.json() as { data?: { bookingId: string; bookingStatus: string; paymentStatus: string; environment: string } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data?.bookingStatus).toBe('confirmed');
  expect(payload.data?.paymentStatus).toBe('captured');
  expect(payload.data?.environment).toBe('sandbox');
  await expect(page.getByText(/BOOKING CONFIRMED/)).toBeVisible({ timeout: 30000 });

  const profileResponse = await providerProfile;
  const profilePayload = profileResponse?.ok() ? await profileResponse.json().catch(() => null) as { data?: { verified?: boolean } } | null : null;
  const verifiedBadge = page.getByText('✓ Verified', { exact: true });
  if (profilePayload?.data?.verified === true) await expect(verifiedBadge).toBeVisible();
  else await expect(verifiedBadge).toHaveCount(0);
});
