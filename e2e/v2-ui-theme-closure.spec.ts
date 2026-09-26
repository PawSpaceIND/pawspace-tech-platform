import { expect, test, type Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import path from "node:path";

type Appearance = { theme: "emerald" | "signature"; style: "cartoon" | "professional"; mode: "light" | "dark" };
const origin = process.env.PW_BASE_URL || "http://localhost:4185";
const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
function routesAt(dir: string, prefix = "/v2"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? routesAt(path.join(dir, entry.name), `${prefix}/${entry.name}`)
    : entry.name === "page.tsx" ? [prefix] : []);
}
const routes = routesAt(path.resolve("app/v2")).sort();
async function choose(page: Page, appearance: Appearance) {
  await page.addInitScript(a => {
    localStorage.setItem("pawspace.customer.theme", a.theme);
    localStorage.setItem("pawspace.visual-style", a.style);
    localStorage.setItem("pawspace.customer.appearance", a.mode);
  }, appearance);
  // Vite dev (plugin-rsc) removes the server-rendered client-component stylesheet links on hydration and re-injects the
  // same CSS as <style> tags moments later. Record those links so visit() can wait for the swap instead of reading styles
  // from an unstyled frame.
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
  await expect(page.locator("html")).toHaveAttribute("data-paw-theme", appearance.theme);
  await expect(page.locator("html")).toHaveAttribute("data-paw-mode", appearance.mode);
  await page.waitForFunction(() => {
    const dev = document.querySelector('script[src^="/@id/"]'), hrefs = (window as unknown as { __v2ClientCss?: string[] }).__v2ClientCss ?? [];
    const injected = Array.from(document.querySelectorAll("style[data-vite-dev-id]"), style => style.getAttribute("data-vite-dev-id") ?? "");
    return !dev || (!document.querySelector('link[rel="stylesheet"][data-precedence^="vite-rsc/client-reference"]') && hrefs.every(href => injected.some(id => id.endsWith(href))));
  }, null, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const consent = page.getByRole("button", { name: "Essential only", exact: true });
  if (await consent.isVisible().catch(() => false)) await consent.click();
  // The consent banner sits at the end of the page, so clicking it scrolls there first. globals.css makes the root
  // scroll smooth; an instant reset keeps geometry from being read mid-animation.
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
}
test.beforeEach(() => test.skip(!local, "UI fixtures and quote requests run only in the isolated local sandbox."));
test.use({ video: "off" });
const variants = [
  { name: "desktop-brand-professional-light", width: 1440, height: 1000, theme: "signature", style: "professional", mode: "light" },
  { name: "desktop-brand-professional-dark", width: 1440, height: 1000, theme: "signature", style: "professional", mode: "dark" },
  { name: "desktop-emerald-illustrated-light", width: 1440, height: 1000, theme: "emerald", style: "cartoon", mode: "light" },
  { name: "mobile-brand-professional-light", width: 390, height: 844, theme: "signature", style: "professional", mode: "light" },
] as const;
for (const variant of variants) test(`V2 route matrix: ${variant.name}`, async ({ page }, info) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: variant.width, height: variant.height });
  await choose(page, variant);
  const evidence: object[] = [];
  for (const route of routes) {
    await visit(page, route, variant);
    await page.waitForTimeout(450);
    const state = await page.evaluate(() => ({ url: location.pathname, theme: { ...document.documentElement.dataset },
      canvas: getComputedStyle(document.querySelector("[data-pawspace-v2]")!).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      headings: Array.from(document.querySelectorAll("h1")).map(e => e.textContent),
      limited: /sign in|signed out|expired|permission denied|incomplete|booking reference/i.test(document.body.innerText) }));
    expect.soft(state.url, route).toBe(route);
    expect.soft(state.scrollWidth, `${route} horizontal overflow`).toBeLessThanOrEqual(state.width + 2);
    expect.soft(state.body, `${route} outer canvas`).toBe(state.canvas);
    evidence.push({ route, ...state });
    await page.screenshot({ path: info.outputPath(route.replaceAll("/", "_") + ".jpg"), type: "jpeg", quality: 65 });
  }
  await info.attach("v2-route-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});
for (const theme of ["emerald", "signature"] as const) for (const mode of ["light", "dark"] as const) {
  for (const style of ["cartoon", "professional"] as const) test(`Home artwork and contrast: ${theme}/${mode}/${style}`, async ({ page }) => {
    const appearance = { theme, mode, style };
    await choose(page, appearance); await visit(page, "/v2", appearance);
    await expect(page.locator('[class*="serviceArt"] img:visible')).toHaveCount(style === "professional" ? 0 : 8);
    await expect(page.locator('[class*="serviceIcon"]:visible')).toHaveCount(style === "professional" ? 8 : 0);
    const pairs = await page.evaluate(() => {
      const pick = (selector: string, parent: string) => { const e = document.querySelector(selector)!, p = e.closest(parent)!;
        return { text: getComputedStyle(e).color, background: getComputedStyle(p).backgroundColor }; };
      return [pick('main[data-v2-home] h1', 'main'), pick('[class*="serviceCopy"] h3', '[data-home-care-tile]'),
        pick('[class*="aiCta"]', '[class*="aiCard"]'), pick('[class*="navCenter"] a', 'main')];
    });
    for (const pair of pairs) expect(contrast(pair.text, pair.background)).toBeGreaterThanOrEqual(4.5);
  });
  test(`Stay labels and destinations: ${theme}/${mode}`, async ({ page }) => {
    const appearance: Appearance = { theme, mode, style: "professional" };
    await choose(page, appearance);
    for (const route of ["/v2/boarding", "/v2/sitting"]) {
      await visit(page, route, appearance);
      const links = page.locator('[class*="modeSwitch"] a'); await expect(links).toHaveCount(2);
      for (const link of await links.all()) {
        const pair = await link.evaluate(e => ({ color: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor,
          hero: getComputedStyle(e.closest('section')!).backgroundColor }));
        expect(contrast(pair.color, pair.bg === "rgba(0, 0, 0, 0)" ? pair.hero : pair.bg)).toBeGreaterThanOrEqual(4.5);
      }
      await expect(links.filter({ hasText: route.endsWith("boarding") ? "Boarding" : "Pet Sitting" })).toHaveAttribute("aria-current", "page");
      await expect(links.nth(0)).toHaveAttribute("href", "/v2/boarding"); await expect(links.nth(1)).toHaveAttribute("href", "/v2/sitting");
    }
  });
}
function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => {
      const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1] + .05) / (values[0] + .05);
}
test("Walking mobile summary stays in flow and quote details remain available", async ({ page }) => {
  const appearance: Appearance = { theme: "emerald", mode: "light", style: "cartoon" };
  await page.setViewportSize({ width: 390, height: 844 }); await choose(page, appearance);
  await visit(page, "/v2/walking", appearance);
  const summary = page.getByRole("complementary", { name: "Walking order summary" });
  await expect(summary).toHaveCSS("position", "static");
  expect((await summary.boundingBox())!.y).toBeGreaterThan(844);
  await expect(page.locator('[data-v2-walking] > header > a:visible')).toHaveCount(0);
  await summary.scrollIntoViewIfNeeded();
  await expect(summary.locator("details")).not.toHaveAttribute("open", "");
  await summary.getByText("Quote details", { exact: true }).click();
  await expect(summary.locator("details")).toHaveAttribute("open", "");
  await expect(summary.locator("details em")).toBeVisible();
  await expect(summary.locator("button")).toBeDisabled();
});
test("V2 actions retain primary controls and the WATI composer", async ({ page }) => {
  const appearance: Appearance = { theme: "signature", mode: "light", style: "professional" };
  await choose(page, appearance);
  for (const route of ["/v2/training", "/v2/food", "/v2/partner", "/v2/boarding", "/v2/chat"]) {
    await visit(page, route, appearance);
    // Chat now uses the shared WATI composer; assert its real Send control instead of the retired V2 marker.
    const action = route === "/v2/chat"
      ? page.getByRole("button", { name: "Send", exact: true })
      : page.locator('[data-v2-action], [data-paw-action="primary"]').first();
    await expect(action, route).toBeVisible();
    await expect(action).toHaveCSS("border-radius", route === "/v2/chat" ? "12px" : "14px");
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});
test("Mobile utilities do not cover dock targets, including the signed-in notification control", async ({ page }) => {
  const appearance: Appearance = { theme: "signature", mode: "light", style: "professional" };
  await page.setViewportSize({ width: 390, height: 844 }); await choose(page, appearance);
  // Presentation fixture only: no auth cookie, protected record, or real notification is created.
  await page.route("**/api/identity-session", r => r.fulfill({ json: { data: { subjectType: "customer", subjectId: "UI-ONLY-FIXTURE" } } }));
  await page.route("**/api/order-notifications?*", r => r.fulfill({ json: { data: { items: [], unread: 0, nextCursor: null } } }));
  for (const route of ["/v2", "/v2/account", "/v2/activity", "/v2/chat", "/v2/boarding"]) {
    await visit(page, route, appearance);
    const appearanceButton = page.getByRole("button", { name: "Change PawSpace appearance" });
    const updates = page.getByRole("button", { name: "Order notifications", exact: true });
    await expect(updates).toBeVisible();
    const utilities = [await appearanceButton.boundingBox(), await updates.boundingBox()];
    const targets = page.locator('nav[aria-label="PawSpace V2 navigation"] a:visible, nav[aria-label="PawSpace mobile navigation"] :is(a,button):visible');
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      for (const utility of utilities) expect(!utility || utility.y + utility.height <= box.y || utility.x + utility.width <= box.x || utility.x >= box.x + box.width).toBe(true);
      expect(await target.evaluate(e => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return hit === e || e.contains(hit); })).toBe(true);
    }
    await updates.click(); await expect(page.getByRole("dialog", { name: "PawSpace order notifications" })).toBeVisible();
    await page.getByRole("button", { name: "Close notifications" }).click();
    await appearanceButton.click(); await expect(page.getByRole("dialog", { name: "Make PawSpace yours." })).toBeVisible();
    await page.getByRole("button", { name: "Close appearance settings" }).click();
  }
});
test("Appearance selections persist across V2 navigation, reload and system display changes", async ({ page }) => {
  await page.goto('/v2');
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', 'emerald');
  const trigger = page.getByRole('button', {name: 'Change PawSpace appearance'});
  await trigger.click();
  const dialog = page.getByRole('dialog', {name: 'Make PawSpace yours.'});
  await dialog.getByRole('radio', {name: /Brand book/}).check();
  await dialog.getByRole('radio', {name: /Professional/}).check();
  await dialog.getByRole('radio', {name: /^dark$/i}).check();
  await dialog.getByRole('button', {name: 'Done', exact: true}).click();
  await page.goto('/v2/workspaces'); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme', 'signature');
  await expect(page.locator('html')).toHaveAttribute('data-paw-style', 'professional');
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'dark');
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(25, 19, 34)');
  await expect(page.locator('main section').first()).toHaveCSS('background-color', 'rgb(50, 22, 79)');
  await trigger.click(); await dialog.getByRole('radio', {name: /^system$/i}).check();
  await dialog.getByRole('button', {name: 'Done', exact: true}).click();
  await page.emulateMedia({colorScheme: 'light'});
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'light');
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode', 'dark');
});

// Local UI fixtures only: not real accounts, payments or booking certification.
const homeServiceCodes = ['grooming','boarding','dog_training','pet_sitting','dog_walking','food','relocation','pet_taxi','funeral_memorial','vet_consult'];
async function compactHomeFixture(page: Page, disabledCode = '') {
  await page.route('**/api/identity-session', r => r.fulfill({status:401,json:{error:'Signed out'}}));
  await page.route('**/api/customer-account', r => r.fulfill({status:401,json:{error:'Signed out'}}));
  await page.route('**/api/service-availability', r => r.fulfill({json:{data:homeServiceCodes.map(code=>({code,enabled:code!==disabledCode}))}}));
}
for (const theme of ['emerald','signature'] as const) for (const style of ['professional','cartoon'] as const) {
 test(`Compact home exposes every service: ${theme}/${style}`, async ({page}, info) => {
  const appearance = {theme,style,mode:'light'} as const;
  await page.setViewportSize({width:390,height:844}); await compactHomeFixture(page);
  await choose(page,appearance); await visit(page,'/v2',appearance); await page.evaluate(()=>scrollTo(0,0));
  const tiles=page.locator('[data-home-care-tile]'); await expect(tiles).toHaveCount(10);
  for(const tile of await tiles.all()) {
    await expect(tile).toBeVisible(); const box=(await tile.boundingBox())!;
    expect(box.y+box.height).toBeLessThan(748); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('[class*="serviceArt"] img:visible')).toHaveCount(style==='cartoon'?8:0);
  await expect(page.locator('[class*="serviceIcon"]:visible')).toHaveCount(style==='professional'?8:0);
  await expect(page.locator('img[src="/assets/pawspace-official-lockup.png"]:visible')).toHaveCount(1);
  await expect(page.getByRole('link',{name:'Vet help Ask PawSpace',exact:true})).toHaveAttribute('href','/v2/chat');
  await expect(page.getByRole('link',{name:'Funeral care Sensitive support',exact:true})).toHaveAttribute('href','/v2/funeral-memorial');
  await page.screenshot({path:info.outputPath(`approved-${theme}-${style}.png`)});
 });
}
test('Compact tiles retain unavailable service states',async({page})=>{
 const a={theme:'emerald',style:'professional',mode:'light'} as const;
 await compactHomeFixture(page,'grooming'); await choose(page,a); await visit(page,'/v2',a);
 await expect(page.locator('[data-home-care-tile="grooming"]')).toContainText('Not taking bookings');
 await expect(page.locator('a[data-home-care-tile="grooming"]')).toHaveCount(0);
});
test('Switching visual styles preserves the current Training form and sends no booking request',async({page})=>{
 const a={theme:'emerald',style:'professional',mode:'light'} as const;await choose(page,a);await visit(page,'/v2/training',a);
 const date=page.locator('input[type="date"]').first();await date.fill('2026-10-15');
 const mutations:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&/booking|payment|scheduling/.test(r.url()))mutations.push(r.url());});
 await page.getByRole('button',{name:'Change PawSpace appearance'}).click();
 const dialog=page.getByRole('dialog',{name:'Make PawSpace yours.'});
 await dialog.getByRole('radio',{name:/Fun/}).check();await dialog.getByRole('radio',{name:/Brand book/}).check();
 await dialog.getByRole('button',{name:'Done',exact:true}).click();
 await expect(date).toHaveValue('2026-10-15');await expect(page.locator('html')).toHaveAttribute('data-paw-style','cartoon');
 await expect(page.locator('html')).toHaveAttribute('data-paw-theme','signature');expect(mutations).toEqual([]);
});

test('Signed-in compact home projects the existing pets and saved area without changing the account',async({page})=>{
 const a={theme:'signature',style:'professional',mode:'light'} as const;
 await compactHomeFixture(page);await choose(page,a);await page.setViewportSize({width:390,height:844});
 await page.route('**/api/identity-session',r=>r.fulfill({json:{data:{subjectType:'customer',subjectId:'COMPACT-UI-FIXTURE'}}}));
 await page.route('**/api/customer-account',r=>r.fulfill({json:{data:{customerId:'COMPACT-UI-FIXTURE',name:'UI Fixture',primaryPhone:'9000000901',bookings:[],foodOrders:[],
   addresses:[{id:'A1',label:'Home',line1:'Fixture street',area:'HSR Layout',city:'Bengaluru',isDefault:true}],
   pets:[{id:'P1',name:'Bruno',species:'dog',breed:'Indie',profile:null},{id:'P2',name:'Milo',species:'cat',breed:'Indie',profile:null}]}}}));
 await page.route('**/api/order-notifications?*',r=>r.fulfill({json:{data:{items:[],unread:0,nextCursor:null}}}));
 const writes:string[]=[];page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 await visit(page,'/v2',a);await expect(page.getByRole('region',{name:'My pets'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Manage Bruno'})).toHaveAttribute('href','/v2/account');
 await expect(page.getByRole('link',{name:'Manage saved service address'})).toContainText('HSR Layout');
 await expect(page.getByRole('link',{name:'◉ Account',exact:true})).toBeVisible();
 expect(writes).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
test('Reduced motion disables the official-logo entrance without delaying service controls',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await compactHomeFixture(page);
 const a={theme:'emerald',style:'professional',mode:'light'} as const;await choose(page,a);await visit(page,'/v2',a);
 const logo=page.locator('img[src="/assets/pawspace-official-lockup.png"]').first();await expect(logo).toHaveCSS('animation-name','none');
 await expect(page.locator('a[data-home-care-tile="grooming"]')).toBeVisible();
});

// UI fixture only: the booking read is fulfilled locally; no booking, order, doorstep or payment request is sent.
const checkoutReadiness = { bookingId: 'B-UI', customerId: 'C-UI', locationReady: false, bookingStatus: 'payment_pending', paymentStatus: 'created',
  confirmation: { ready: false, bookingId: 'B-UI', serviceCode: 'grooming', packageName: 'Bath & Basic', bookingStatus: 'payment_pending', paymentId: 'P-UI',
    paymentMode: 'prepaid', paymentStatus: 'created', transactionId: null, amountDueNow: 1899, totalAmount: 1899, currency: 'INR', providerId: 'PRV-UI',
    providerName: 'UI Fixture Groomer', providerModel: 'full_time', workOrderStatus: 'payment_pending', scheduledStart: '2026-10-01T04:30:00.000Z',
    scheduledEnd: '2026-10-01T06:30:00.000Z', updatedAt: 1, pets: [{ id: 'PET-UI', name: 'Bruno', species: 'dog', breed: 'Indie' }] } };
for (const theme of ['emerald','signature'] as const) for (const mode of ['light','dark'] as const) test(`Grooming checkout follows the selected palette: ${theme}/${mode}`, async ({page}) => {
  const appearance: Appearance = {theme, mode, style: 'professional'};
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

test('Funeral care Back returns to the request list without reopening the case', async ({page}) => {
  // UI fixture only: the account and request reads are fulfilled locally; no support request is created or changed.
  const a: Appearance = {theme: 'emerald', style: 'professional', mode: 'light'};
  const item = {id: 'FUNERAL-UI-1', customer_id: 'C-UI', pet_name: 'Bruno', pet_species: 'dog', pickup_address: 'Fixture street, Bengaluru', service_type: 'cremation',
    memorial_option: 'none', urgency: 'urgent', status: 'requested', support_status: 'none', certificate_status: 'not_issued', created_at: 1, updated_at: 1, payment: null, milestones: [], media: []};
  await page.route('**/api/customer-account', r => r.fulfill({json: {data: {customerId: 'C-UI', name: 'UI Fixture', primaryPhone: '9000000902', addresses: [], bookings: [], pets: []}}}));
  const caseReads: string[] = [];
  await page.route('**/api/funeral-memorial?*', r => { const url = new URL(r.request().url()), caseId = url.searchParams.get('caseId');
    if (caseId) caseReads.push(caseId); return r.fulfill({json: {data: caseId ? item : [item], readiness: {}, templates: {}}}); });
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await choose(page, a); await visit(page, '/v2/funeral-memorial', a);
  await page.getByRole('button', {name: /FUNERAL-UI-1/}).click();
  await expect(page.getByRole('heading', {name: 'Support request FUNERAL-UI-1'})).toBeVisible();
  const refreshed = page.waitForResponse(r => r.url().includes('/api/funeral-memorial?scope=customer'));
  await page.getByRole('button', {name: 'Back to requests'}).click(); await refreshed; await page.waitForTimeout(500);
  await expect(page.getByRole('heading', {name: 'Create a sensitive support request'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Support request FUNERAL-UI-1'})).toHaveCount(0);
  expect(caseReads).toEqual(['FUNERAL-UI-1']); expect(writes).toEqual([]);
});
