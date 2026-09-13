import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Google Maps lookup has a deadline and a manual-address service-area fallback', async () => {
  const [client, picker] = await Promise.all([read('lib/address-autocomplete-client.ts'), read('app/mobile-app/address-picker.tsx')]);
  assert.match(client, /AbortController/);
  assert.match(client, /8_000/);
  assert.match(client, /Address lookup timed out/);
  assert.match(picker, /configuration_required\|timeout\|timed out/);
  assert.match(picker, /Continue with manual address/);
  assert.match(picker, /sessionStorage\.getItem\(SELECTED_SERVICE_ADDRESS_KEY\)/);
});

test('critical booking flows use synchronous action locks before booking mutations', async () => {
  for (const file of ['grooming-flow.tsx','stay-flow.tsx','training-flow.tsx','walking-flow.tsx','taxi-flow.tsx','food-flow.tsx']) {
    const source = await read(`app/mobile-app/${file}`);
    assert.match(source, /actionLock=useRef\(false\)/, file);
    assert.match(source, /actionLock\.current/, file);
  }
});

test('browser back is wired to customer flow stages without discarding React selections', async () => {
  const history = await read('lib/use-flow-history.ts');
  assert.match(history, /popstate/);
  assert.match(history, /history\.pushState/);
  for (const file of ['grooming-flow.tsx','training-flow.tsx','walking-flow.tsx','taxi-flow.tsx','food-flow.tsx']) {
    assert.match(await read(`app/mobile-app/${file}`), /useFlowHistory\(/, file);
  }
});

test('delayed Razorpay webhook renders waiting state and polls the same receipt', async () => {
  const checkout = await read('app/mobile-app/customer-checkout-button.tsx');
  assert.match(checkout, /state\.phase === "pending"/);
  assert.match(checkout, /setInterval/);
  assert.match(checkout, /Waiting for payment confirmation/);
  assert.match(checkout, /controller\.current\?\.start\(\)/);
});

test('provider proof calls have bounded 3G failure behavior and replay-safe retry guidance', async () => {
  const [proof, bounded] = await Promise.all([read('lib/boarding-proof-client.ts'), read('lib/bounded-fetch.ts')]);
  assert.match(proof, /boundedFetch/);
  assert.match(bounded, /20_000/);
  assert.match(bounded, /AbortController/);
  assert.match(bounded, /Please retry; replay-safe actions will reuse their idempotency key/);
});

test('Booking Wizard, Pet Manager and Payment Screen have local error boundaries', async () => {
  const [shell, checkout, boundary] = await Promise.all([
    read('app/mobile-app/page.tsx'), read('app/mobile-app/customer-checkout-button.tsx'), read('app/components/critical-error-boundary.tsx')
  ]);
  assert.match(shell, /CriticalErrorBoundary name="Booking Wizard"/);
  assert.match(shell, /CriticalErrorBoundary name="Pet Manager"/);
  assert.match(checkout, /CriticalErrorBoundary name="Payment Screen"/);
  assert.match(boundary, /Something went wrong\./);
  assert.match(boundary, /Reload section/);
});

test('hung Maps request is aborted instead of hanging forever', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_input, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true });
  });
  const { searchAddresses } = await import(`../lib/address-autocomplete-client.ts?chaos=${Date.now()}`);
  const request = searchAddresses('1 Test Street, Bengaluru 560001', 'session-test');
  const assertion = assert.rejects(request, /Address lookup timed out/);
  t.mock.timers.tick(8_001);
  await assertion;
});

test('hung provider proof request aborts and explicitly permits retry', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_input, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true });
  });
  const { boundedFetch } = await import(`../lib/bounded-fetch.ts?chaos=${Date.now()}`);
  const request = boundedFetch('/api/proof-chaos', { method: 'POST' });
  const assertion = assert.rejects(request, /timed out.*Please retry.*idempotency key/i);
  t.mock.timers.tick(20_001);
  await assertion;
});
