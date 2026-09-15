/*
 * R3-A4 — /mobile-app?service=grooming silently did nothing, and only grooming.
 *
 * MEASURED: all eight service codes were swept in a browser. boarding, dog_training, pet_sitting,
 * dog_walking, food, pet_taxi and relocation each landed on "Book <service>"; grooming alone landed
 * on the discovery Home tab. Grooming is services[0], so the deep-link effect's
 * `requestedService !== service.serviceCode` guard was already false on the first pass and the tab
 * was never switched — the flagship service was the one whose deep links were dead.
 *
 * The same guard had a second effect nobody had reported: it re-ran on every service change, so a
 * customer who opened ?service=boarding and then tapped another service was dragged back.
 *
 * This suite EXECUTES the real page component: effects run, state settles, and the assertion is on
 * the heading the customer would actually see. `lib/use-query-parameter.ts` is stubbed because its
 * useSyncExternalStore server snapshot is always "" outside a browser — the stub supplies the URL,
 * nothing about the code under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, screenText, memoryStorage } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3A_DEEPLINK_DB__", "__R3A_DEEPLINK_ENV__");

const QUERY_STUB = `data:text/javascript,${encodeURIComponent(
  'export const useQueryParameter=(name)=>String((globalThis.__R3A_QUERY__||{})[name]||"");',
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/use-query-parameter$/.test(specifier)) return { url: QUERY_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { default: MobileApp } = await import("../app/mobile-app/page.tsx");

/** Every service code the app's own discovery list offers, taken from the rendered Home screen. */
const SERVICE_TITLES = {
  grooming: "Book Grooming",
  dog_training: "Book Training",
  boarding: "Book Boarding",
  pet_sitting: "Book Pet Sitting",
  pet_taxi: "Book Pet Taxi",
  dog_walking: "Book Dog Walking",
  food: "Book Fresh Food",
  relocation: "Book Relocation",
};

function browserWorld(t, query) {
  globalThis.__R3A_QUERY__ = query;
  const priorFetch = globalThis.fetch;
  const priorWindow = globalThis.window;
  const storage = memoryStorage();
  const listeners = new Set();
  globalThis.window = {
    localStorage: storage, sessionStorage: memoryStorage(),
    addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn),
    dispatchEvent: () => true, location: { search: "", href: "https://uat.pawspace.test/mobile-app" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms), prompt: () => "",
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    // A signed-out visitor: the grooming wizard is the one flow reachable before OTP, which is why
    // grooming is services[0] in the first place.
    if (href.startsWith("/api/identity-session")) return Response.json({ data: {} }, { status: 401 });
    if (href.startsWith("/api/service-availability")) return Response.json({ data: [] });
    if (href.startsWith("/api/customer-profile")) return Response.json({ data: null }, { status: 401 });
    return Response.json({ data: null }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = priorFetch; globalThis.window = priorWindow; delete globalThis.__R3A_QUERY__; });
}

test("OUTCOME: every service deep link lands on that service's Book screen — grooming included", async (t) => {
  for (const [serviceCode, expected] of Object.entries(SERVICE_TITLES)) {
    browserWorld(t, { service: serviceCode });
    const screen = mount(MobileApp, {}, { label: `MobileApp?service=${serviceCode}` });
    await screen.settle();
    const text = screenText(screen.html());
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `?service=${serviceCode} must open "${expected}"; the screen showed: ${text.slice(0, 200)}`);
  }
});

test("no deep link at all still opens on discovery home, so the parameter is what moves the tab", async (t) => {
  browserWorld(t, {});
  const screen = mount(MobileApp, {}, { label: "MobileApp (no query)" });
  await screen.settle();
  const text = screenText(screen.html());
  assert.doesNotMatch(text, /Book Grooming/, "without ?service the app must not jump into a booking wizard");
  assert.match(text, /Good morning/, "the default landing is discovery home");
});

test("an unknown service code is ignored rather than opening the wrong wizard", async (t) => {
  browserWorld(t, { service: "not_a_service" });
  const screen = mount(MobileApp, {}, { label: "MobileApp?service=not_a_service" });
  await screen.settle();
  assert.doesNotMatch(screenText(screen.html()), /Book Grooming|Book Boarding/);
});

test("?tab=book&service=grooming — the workaround the auditor had to use — still works", async (t) => {
  browserWorld(t, { tab: "book", service: "grooming" });
  const screen = mount(MobileApp, {}, { label: "MobileApp?tab=book&service=grooming" });
  await screen.settle();
  assert.match(screenText(screen.html()), /Book Grooming/);
});
