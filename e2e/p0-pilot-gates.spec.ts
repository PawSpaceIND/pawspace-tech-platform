import { expect, test, type Page } from '@playwright/test';

const accessCode = process.env.P0_UAT_ACCESS_CODE || '';

function attachBrowserFailureGuards(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Browser extensions and missing favicons are outside the product runtime. Everything else is a gate failure.
    if (/favicon\.ico/i.test(text)) return;
    failures.push(`console.error: ${text}`);
  });
  return async () => {
    await page.waitForTimeout(500);
    expect(failures, failures.join('\n')).toEqual([]);
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyText: (document.body?.innerText || '').trim(),
    }));
    expect(layout.bodyText.length, 'page rendered no usable text').toBeGreaterThan(20);
    expect(layout.scrollWidth, `horizontal overflow ${layout.scrollWidth}px > ${layout.innerWidth}px`).toBeLessThanOrEqual(layout.innerWidth + 2);
    const html = await page.locator('html').innerHTML();
    expect(html).not.toMatch(/hydration (failed|error)|there was an error while hydrating|react hydration error/i);
  };
}

async function signInStaff(page: Page, email: string) {
  expect(accessCode, 'P0_UAT_ACCESS_CODE must be supplied from the protected release-preview environment').not.toBe('');
  const response = await page.request.post('/api/staging-login', {
    data: { action: 'login', code: accessCode, email },
  });
  const text = await response.text();
  expect(response.ok(), `UAT sign-in failed for ${email}: ${response.status()} ${text.slice(0, 300)}`).toBeTruthy();
}

async function openAndAssert(page: Page, path: string, heading?: RegExp) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, `${path} returned no navigation response`).not.toBeNull();
  expect(response!.status(), `${path} returned ${response!.status()}`).toBeLessThan(500);
  await page.waitForLoadState('networkidle').catch(() => {});
  if (heading) await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
}

test.describe('P0 hosted browser certification', () => {
  test('customer: sandbox OTP login and core service surface', async ({ page }) => {
    const assertHealthy = attachBrowserFailureGuards(page);
    await openAndAssert(page, '/');
    const login = page.getByRole('button', { name: /login/i }).or(page.getByRole('link', { name: /login/i })).first();
    await expect(login).toBeVisible();
    await login.click();
    const dialog = page.getByRole('dialog', { name: /customer login/i });
    await expect(dialog).toBeVisible();
    const phone = `9${String(Date.now()).slice(-9)}`;
    await dialog.getByLabel('Phone number').fill(phone);
    await dialog.getByRole('button', { name: /send otp/i }).click();
    const otp = dialog.getByLabel('OTP code');
    await expect(otp).toBeVisible();
    const copy = await dialog.innerText();
    const code = copy.match(/\b(\d{6})\b/)?.[1] || '';
    expect(code, `sandbox OTP absent from dialog: ${copy.slice(0, 300)}`).toMatch(/^\d{6}$/);
    await otp.fill(code);
    await dialog.getByRole('button', { name: /verify & continue/i }).click();
    await expect(dialog).toBeHidden();
    await openAndAssert(page, '/grooming');
    await assertHealthy();
  });

  test('provider: provider-linked groomer sees authenticated Partner workspace', async ({ page }) => {
    const assertHealthy = attachBrowserFailureGuards(page);
    await signInStaff(page, 'uat.demo.groomer@tkpetcare.in');
    await openAndAssert(page, '/partner-app');
    await expect(page.getByText(/verified/i).first()).toBeVisible();
    await expect(page.getByText(/verified provider session required/i)).toHaveCount(0);
    await assertHealthy();
  });

  test('operations: manager can load scheduling workspace without privilege escalation', async ({ page }) => {
    const assertHealthy = attachBrowserFailureGuards(page);
    await signInStaff(page, 'jyoti.manager39@tkpetcare.in');
    await openAndAssert(page, '/team/scheduling');
    await expect(page.getByText(/permission denied|access has not been provisioned/i)).toHaveCount(0);
    await assertHealthy();
  });

  test('admin: founder can load governance control surface', async ({ page }) => {
    const assertHealthy = attachBrowserFailureGuards(page);
    await signInStaff(page, 'founder@pawspace.in');
    await openAndAssert(page, '/control');
    await expect(page.getByText(/permission denied|access has not been provisioned/i)).toHaveCount(0);
    await assertHealthy();
  });

  test('RBAC negative: associate cannot silently inherit founder authority', async ({ page }) => {
    await signInStaff(page, 'anita.associate17@tkpetcare.in');
    const response = await page.request.get('/api/ai-rollout');
    expect([401, 403], `associate unexpectedly reached privileged AI rollout API with ${response.status()}`).toContain(response.status());
  });
});
