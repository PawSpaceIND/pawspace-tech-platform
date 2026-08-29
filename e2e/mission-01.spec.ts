import { test } from '@playwright/test';

test('Mission 06: full autonomous login', async ({ page }) => {
  page.setDefaultTimeout(10000);
  await page.goto('/');
  const login = page.getByRole('button', { name: /login/i }).or(page.getByRole('link', { name: /login/i })); await login.first().click();

  const phone = page.locator('input').first();
  await phone.waitFor();
  await phone.fill('9876543210');
  console.log('STEP 1 OK: phone filled');

  await page.getByRole('button', { name: /send otp/i }).first().click();
  console.log('STEP 2 OK: send otp clicked');

  await page.waitForTimeout(1500);
  const otpText = await page.locator('body').innerText();
  console.log('--- OTP SCREEN ---');
  console.log(otpText.slice(0, 1500));
  const m = otpText.match(/\b(\d{6})\b/) || otpText.match(/\b(\d{4})\b/);
  const code = m ? m[1] : '';
  console.log('DETECTED CODE:', code);

  const otpInput = page.locator('input').last();
  await otpInput.waitFor();
  await otpInput.fill(code);
  console.log('STEP 3 OK: code filled');

  await page.getByRole('dialog').getByRole('button', { name: /verify|continue|sign in|confirm|submit/i }).first().click();
  await page.waitForTimeout(2500);
  console.log('URL NOW:', page.url());
  await page.screenshot({ path: 'e2e/shots/05-loggedin.png', fullPage: true });
  const dash = await page.locator('body').innerText();
  console.log('LOGGED IN (no phone prompt):', !/Enter your phone number/.test(dash));
  console.log('--- AFTER LOGIN ---');
  console.log(dash.slice(0, 2500));
  console.log('--- END ---');
});
