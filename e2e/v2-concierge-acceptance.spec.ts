import { expect, test, type Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import path from "node:path";

// Modern Concierge ("concierge") acceptance gate, Stage C (4 Oct 2026). Runs only against the isolated local sandbox
// started with NEXT_PUBLIC_PAWSPACE_CONCIERGE_AVAILABLE=true (PW_CONCIERGE_GATE=open tells the spec that build is up).
// The release flag itself is never set here; the deployment owner sets it after this evidence is attached.
// G1 rendered matrix, G2 contrast, G3 dialog and persistence, G4 art source isolation, G5 bounded e2e.
type Appearance = { mode: "light" | "dark" };
const THEME = "concierge";
const origin = process.env.PW_BASE_URL || "http://localhost:4185";
const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
const gateOpen = process.env.PW_CONCIERGE_GATE === "open";
function routesAt(dir: string, prefix = "/v2"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? routesAt(path.join(dir, entry.name), `${prefix}/${entry.name}`)
    : entry.name === "page.tsx" ? [prefix] : []);
}
const routes = routesAt(path.resolve("app/v2")).sort();
async function choose(page: Page, appearance: Appearance) {
  // Explicit Concierge choice in the device record; the same cookie renders Editorial while the gate is closed (resolver tests).
  await page.context().addCookies([{ name: "pawspace-appearance", value: `v1.${THEME}.editorial.${appearance.mode}.-`, url: origin }]);
  await page.addInitScript(() => {
    const hrefs: string[] = (window as unknown as { __v2ClientCss: string[] }).__v2ClientCss = [];
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes)
      if (node instanceof HTMLLinkElement && node.rel === "stylesheet" && node.dataset.precedence?.startsWith("vite-rsc/client-reference")) hrefs.push(new URL(node.href).pathname);
    }).observe(document, { childList: true, subtree: true });
  });
}
async function visit(page: Page, route: string, appearance: Appearance) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-pawspace-v2]")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-paw-theme", THEME);
  await expect(page.locator("html")).toHaveAttribute("data-paw-style", "professional");
  await expect(page.locator("html")).toHaveAttribute("data-paw-mode", appearance.mode);
  await page.waitForFunction(() => {
    const dev = document.querySelector('script[src^="/@id/"]'), hrefs = (window as unknown as { __v2ClientCss?: string[] }).__v2ClientCss ?? [];
    const injected = Array.from(document.querySelectorAll("style[data-vite-dev-id]"), style => style.getAttribute("data-vite-dev-id") ?? "");
    return !dev || (!document.querySelector('link[rel="stylesheet"][data-precedence^="vite-rsc/client-reference"]') && hrefs.every(href => injected.some(id => id.endsWith(href))));
  }, null, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const consent = page.getByRole("button", { name: "Essential only", exact: true });
  await consent.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
  if (await consent.isVisible().catch(() => false)) await consent.click();
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
}
test.beforeEach(() => { test.skip(!local, "UI fixtures run only in the isolated local sandbox."); test.skip(!gateOpen, "Needs the local test build with the Concierge gate open (PW_CONCIERGE_GATE=open)."); });
test.use({ video: "off" });
const variants = [
  { name: "desktop-concierge-light", width: 1440, height: 1000, mode: "light" },
  { name: "desktop-concierge-dark", width: 1440, height: 1000, mode: "dark" },
  { name: "mobile-concierge-light", width: 390, height: 844, mode: "light" },
] as const;
const ROUTES_PER_CASE = 8;
if (!routes.length) throw new Error("No PawSpace V2 routes were discovered.");
const routeBatches = Array.from({ length: Math.ceil(routes.length / ROUTES_PER_CASE) }, (_, index) =>
  routes.slice(index * ROUTES_PER_CASE, (index + 1) * ROUTES_PER_CASE));
for (const variant of variants) for (const [index, batch] of routeBatches.entries()) test(
  `Concierge route matrix: ${variant.name} [batch ${index + 1}/${routeBatches.length}]`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: variant.width, height: variant.height });
  await choose(page, variant);
  // G4: every native art request while Concierge is effective must come from the concierge set.
  const art: string[] = []; page.on("request", r => { const u = new URL(r.url()); if (u.pathname.startsWith("/assets/native/")) art.push(u.pathname); });
  const evidence: object[] = [];
  try {
  for (const route of batch) {
    await visit(page, route, variant);
    await page.waitForTimeout(450);
    const state = await page.evaluate(() => ({ url: location.pathname, theme: { ...document.documentElement.dataset },
      canvas: getComputedStyle(document.querySelector("[data-pawspace-v2]")!).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      headings: Array.from(document.querySelectorAll("h1")).map(e => e.textContent),
      h1Font: document.querySelector("h1") ? getComputedStyle(document.querySelector("h1")!).fontFamily : null,
      sceneSources: Array.from(document.querySelectorAll(".ps-service-art img, picture img"), img => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src).map(s => new URL(s, location.origin).pathname).filter(p => p.startsWith("/assets/native/")),
      limited: /sign in|signed out|expired|permission denied|incomplete|booking reference/i.test(document.body.innerText) }));
    expect.soft(state.url, route).toBe(route);
    expect.soft(state.scrollWidth, `${route} horizontal overflow`).toBeLessThanOrEqual(state.width + 2);
    expect.soft(state.body, `${route} outer canvas`).toBe(state.canvas);
    for (const source of state.sceneSources) expect.soft(source, `${route} rendered art source`).toContain("/assets/native/concierge/");
    evidence.push({ route, ...state });
    await page.screenshot({ path: info.outputPath(route.replaceAll("/", "_") + ".jpg"), type: "jpeg", quality: 65 });
  }
  const editorialRequests = art.filter(p => p.includes("/editorial/"));
  expect.soft(editorialRequests, "no Editorial art requested while Concierge is effective").toEqual([]);
  } finally {
  await info.attach("concierge-route-evidence", { body: JSON.stringify({ evidence, artRequests: Array.from(new Set(art)) }, null, 2), contentType: "application/json" });
  }
});
for (const mode of ["light", "dark"] as const) test(`Concierge home artwork and contrast: ${mode}`, async ({ page }) => {
  const appearance: Appearance = { mode };
  await choose(page, appearance); await visit(page, "/v2", appearance);
  await expect(page.locator('[class*="serviceArt"] img:visible')).toHaveCount(8);
  const pairs = await page.evaluate(() => {
    const pick = (selector: string, parent: string) => { const e = document.querySelector(selector)!, p = e.closest(parent)!;
      return { text: getComputedStyle(e).color, background: getComputedStyle(p).backgroundColor }; };
    return [pick('main[data-v2-home] h1', 'main'), pick('[class*="serviceCopy"] h3', '[data-home-care-tile]'),
      pick('[class*="aiCta"]', '[class*="aiCard"]'), pick('[class*="navCenter"] a', 'main')];
  });
  for (const pair of pairs) expect(contrast(pair.text, pair.background)).toBeGreaterThanOrEqual(4.5);
  // G2 boundary: the filled primary action carries the 2 px primary edge with at least 3:1 against the hero surface.
  const edge = await page.locator('main[data-v2-home] [data-paw-action="primary"], main[data-v2-home] [class*="primaryAction"]').first().evaluate(e => {
    // The approved home hero is a transparent section on the canvas, so resolve the first painted ancestor background.
    let node: Element | null = e.parentElement, surface = "rgba(0, 0, 0, 0)";
    while (node && /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(surface)) { surface = getComputedStyle(node).backgroundColor; node = node.parentElement; }
    const s = getComputedStyle(e); return { width: s.borderTopWidth, color: s.borderTopColor, surface };
  });
  expect(edge.width).toBe("2px");
  expect(contrast(edge.color, edge.surface)).toBeGreaterThanOrEqual(3);
});
test("Concierge is offered when the gate is open and the choice persists across navigation, reload and system display changes", async ({ page }) => {
  await page.context().addCookies([{ name: "pawspace-appearance", value: "v1.-.editorial.light.-", url: origin }]);
  await page.goto('/v2');
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', 'editorial');
  const trigger = page.getByRole('button', {name: 'Change PawSpace appearance'});
  const dialog = page.getByRole('dialog', {name: 'Make PawSpace yours.'});
  await expect.poll(async () => { await trigger.click(); await page.waitForTimeout(300); return dialog.isVisible(); }, { timeout: 20_000 }).toBe(true);
  await expect(dialog.getByRole('radio', {name: /Editorial Sanctuary/})).toBeChecked();
  const concierge = dialog.getByRole('radio', {name: /Modern Concierge/});
  await expect(concierge).toBeEnabled();
  await concierge.check();
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', THEME);
  await dialog.getByRole('radio', {name: /^dark$/i}).check();
  await dialog.getByRole('button', {name: 'Done', exact: true}).click();
  const cookie = (await page.context().cookies()).find(c => c.name === 'pawspace-appearance');
  expect(cookie?.value).toBe('v1.concierge.editorial.dark.-');
  await page.goto('/v2/workspaces'); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', THEME);
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'dark');
  await trigger.click(); await dialog.getByRole('radio', {name: /^system$/i}).check();
  await dialog.getByRole('button', {name: 'Done', exact: true}).click();
  await page.emulateMedia({colorScheme: 'light'});
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'light');
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', THEME);
});
const checkoutReadiness = { bookingId: 'B-UI', customerId: 'C-UI', locationReady: false, bookingStatus: 'payment_pending', paymentStatus: 'created',
  confirmation: { ready: false, bookingId: 'B-UI', serviceCode: 'grooming', packageName: 'Bath & Basic', bookingStatus: 'payment_pending', paymentId: 'P-UI',
    paymentMode: 'prepaid', paymentStatus: 'created', transactionId: null, amountDueNow: 1899, totalAmount: 1899, currency: 'INR', providerId: 'PRV-UI',
    providerName: 'UI Fixture Groomer', providerModel: 'full_time', workOrderStatus: 'payment_pending', scheduledStart: '2026-10-01T04:30:00.000Z',
    scheduledEnd: '2026-10-01T06:30:00.000Z', updatedAt: 1, pets: [{ id: 'PET-UI', name: 'Bruno', species: 'dog', breed: 'Indie' }] } };
for (const mode of ['light','dark'] as const) test(`Concierge Grooming checkout palette: ${mode}`, async ({page}) => {
  const appearance: Appearance = {mode};
  await page.route('**/api/v2/grooming-checkout?*', r => r.fulfill({json: {data: checkoutReadiness}}));
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await choose(page, appearance); await visit(page, '/v2/grooming?bookingId=B-UI', appearance);
  const card = page.getByRole('region', {name: 'Grooming checkout'});
  await expect(card.getByText('UI Fixture Groomer')).toBeVisible(); await expect(card.getByLabel('PIN code')).toBeVisible();
  const colors = await card.evaluate(e => {
    const color = (el: Element | null) => getComputedStyle(el!).color, bg = (el: Element | null) => getComputedStyle(el!).backgroundColor;
    const q = (selector: string) => e.querySelector(selector), fact = q('[class*="checkoutFacts"] div');
    return { main: bg(e.closest('main')), canvas: bg(document.querySelector('[data-pawspace-v2]')), pairs: [
      [color(q('h1')), bg(e)], [color(q(':scope > p')), bg(e)], [color(fact!.querySelector('span')), bg(fact)], [color(fact!.querySelector('b')), bg(fact)],
      [color(q('[class*="safe"] p')), bg(q('[class*="safe"]'))], [color(q('form label')), bg(e)], [color(q('form input')), bg(q('form input'))],
      [color(q('[class*="statusButton"]')), bg(q('[class*="statusButton"]'))], [color(q('[class*="doneLink"]')), bg(q('[class*="doneLink"]'))],
      [color(q('[class*="receiptNote"]')), bg(e)]] };
  });
  expect(colors.main).toBe(colors.canvas);
  for (const [text, background] of colors.pairs) expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  expect(writes).toEqual([]);
});
function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => {
      const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1] + .05) / (values[0] + .05);
}
