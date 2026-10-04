import { test, expect, type Page } from "@playwright/test";
import { chooseFirstNamedGroomer } from "./helpers/v2-groomer-selection";

type Fixture = {
  reverseCalls: number; reverseGate?: Promise<void>; reverseResult?: Record<string, unknown>;
  bookingCount?: number; offersUnavailable?: boolean; normalOffers?: boolean; offerGate?: Promise<void>; offerReads?: number; offerValues?: Array<{code:string;savings:number}>; couponDiscounts?: Record<string,number>;
  bookingWrites: number; orderWrites: number; locationWrites: number; locationFailures: number;
  providers?: Array<{ id: string; name: string; model: string; rating: number }>;
  couponGate?: Promise<void>; couponStarted: boolean; couponValid?: boolean; couponDiscount?: number; couponFinalOverride?: number; couponInputs: Array<{code:string;orderValue:number}>;
  assignedProvider?: { id: string; name: string; model: string; rating: number }; reserveRefusal?: string;
  captured: boolean; confirmed: boolean; locationReady: boolean; unauthorized: boolean; quoteSource: string;
  previewGate?: Promise<void>; coverageGate?: Promise<void>; previewStarted: boolean; coverageStarted: boolean;
  booking: Record<string, unknown> | null; reservation: Record<string, unknown> | null;
};
async function fixture(page: Page) {
  const state: Fixture = { reverseCalls: 0, bookingWrites: 0, orderWrites: 0, locationWrites: 0, locationFailures: 0,
    captured: false, confirmed: false, locationReady: false, unauthorized: false, quoteSource: "pricing_control",
    previewStarted: false, coverageStarted: false, couponStarted: false, couponInputs: [], booking: null, reservation: null };
  const provider = { id: "PRV1", name: "Arjun - PawSpace Care", model: "full_time", rating: 4.9 };
  const bundle = { petCount: 1, packageCode: "dog-basic", price: 1899, currency: "INR", slotMinutes: 120,
    blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  await page.addInitScript(() => {
    // Explicit SDK transport double. No request goes to a real payment provider.
    (window as unknown as { Razorpay: unknown }).Razorpay = class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) { this.options = options; }
      on() {} close() {}
      open() {
        const handler = this.options.handler as (result: Record<string, string>) => void;
        queueMicrotask(() => handler({ razorpay_order_id: "order_v2_fixture", razorpay_payment_id: "pay_v2_fixture", razorpay_signature: "a".repeat(64) }));
      }
    };
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : {};
    const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    if (path === "/api/identity-session") return reply({ subjectType: "customer", subjectId: "C1" });
    if (path === "/api/service-availability") return reply([{ code: "grooming", enabled: true }]);
    if (path === "/api/customer-account") return reply({ customerId: "C1", name: "Meera", primaryPhone: "9000000901", addresses: [], bookings: [],
      pets: [{ id: "PET-1", sourceId: "PET-1", name: "Bruno", species: "dog", breed: "Golden Retriever", ageYears: 3, vaccinationStatus: "verified" }] });
    if (path === "/api/v2/grooming-catalogue") return reply({ serviceCode: "grooming", packages: [{ code: "dog-basic", name: "Bath & Basic",
      description: "A gentle bath, coat care and finishing touches for your best friend.", audience: "dog", bundles: [bundle] }] });
    if (path === "/api/service-zone") {
      state.coverageStarted = true; if (state.coverageGate) await state.coverageGate;
      return reply({ assignment: { cityId: "blr", city: "Bengaluru", zoneId: "blr-east", pincode: url.searchParams.get("pincode"), area: "Indiranagar" },
        zone: { zoneId: "blr-east", zoneName: "Bengaluru East", serviceAvailable: true } });
    }
    if (path === "/api/address-autocomplete") {
      expect(request.method()).toBe("GET"); expect(url.searchParams.get("mode")).toBe("reverse");
      state.reverseCalls++;
      if (state.reverseGate) await state.reverseGate;
      return reply(state.reverseResult || { status: "configured", address: "42 Indiranagar Double Road, Bengaluru 560038", pincode: "560038",
        latitude: Number(url.searchParams.get("latitude")), longitude: Number(url.searchParams.get("longitude")) });
    }
    if (path === "/api/live-price-quote") return reply({ price: 1899, source: state.quoteSource });
    if (path === "/api/uat-scheduling") {
      if (body.action === "preview") {
        state.previewStarted = true; if (state.previewGate) await state.previewGate;
        expect(body.serviceAddress).toContain("Indiranagar"); expect(body.servicePincode).toBe("560038");
        return reply({ providers: state.providers || [provider], availabilityChecked: true, reserved: false, cityId: body.cityId, zoneId: body.zoneId,
          scheduledStart: body.scheduledStart, scheduledEnd: body.scheduledEnd });
      }
      state.reservation = body; if(state.reserveRefusal)return route.fulfill({status:409,json:{error:state.reserveRefusal}}); return reply({ groupId: body.clientRequestId, provider:state.assignedProvider||provider });
    }
    if (path === "/api/customer-offers") {
      state.offerReads=(state.offerReads||0)+1;
      if(state.offerGate)await state.offerGate;
      if(state.offersUnavailable)return route.fulfill({status:503,json:{error:"Available offers are temporarily unavailable"}});
      const count=state.bookingCount||0;
      // Most original booking tests explicitly have no promotion. Dedicated auto-offer cases opt in.
      const coupons=count<3&&state.normalOffers?(state.offerValues||[{code:"NORMAL",savings:200}]).map(item=>({code:item.code,name:item.code==="NORMAL"?"Normal grooming offer":item.code,discountType:"fixed",discountValue:item.savings,maxDiscount:item.savings,minOrder:500,description:`₹${item.savings} off on orders above ₹500`,autoApply:false,savings:item.savings,finalAmount:Number(url.searchParams.get("orderValue"))-item.savings})):[];
      return reply({normalCouponsAllowed:count<3,bookingCount:count,coupons,autoApply:coupons[0]||null,message:count>=3?"Normal offers are available for your first three bookings. Use a special code issued to your account.":undefined});
    }
    if (path === "/api/coupon-governance") {
      const input = body.input as { code: string; orderValue: number }, valid = state.couponValid !== false && !(input.code==="NORMAL" && (state.bookingCount||0)>=3);
      state.couponStarted = true; state.couponInputs.push(input);
      if (state.couponGate) await state.couponGate;
      const discount = state.couponDiscounts?.[input.code] ?? state.couponDiscount ?? 200;
      return reply(valid ? { valid: true, code: input.code, discount, quoteId: `CPQ-${input.code}`, finalAmount: state.couponFinalOverride ?? (Math.round(input.orderValue * 100) - Math.round(discount * 100)) / 100 }
        : { valid: false, discount: 0, error: "The previous coupon is no longer available" });
    }
    if (path === "/api/canonical-bookings") {
      state.bookingWrites++; state.booking = body;
      return reply({ bookingId: "B1", customerId: "C1", petIds: ["PET-1"], scheduleGroupId: body.scheduleGroupId,
        workOrderId: "WO1", paymentId: "P1", status: "payment_pending", duplicatePrevented: false });
    }
    if (path === "/api/grooming-service-location") {
      state.locationWrites++;
      if (state.locationFailures-- > 0) return route.fulfill({ status: 503, json: { error: "Address verification temporarily unavailable" } });
      state.locationReady = true; return reply({ bookingId: "B1", addressSaved: true, coordinatesSaved: true });
    }
    if (path === "/api/v2/grooming-checkout") {
      if (state.unauthorized) return route.fulfill({ status: 401, json: { error: "Sign in to the customer account that made this booking." } });
      return reply({ bookingId: "B1", customerId: "C1", locationReady: state.locationReady,
        bookingStatus: state.confirmed ? "confirmed" : "payment_pending", paymentStatus: state.captured ? "captured" : "created",
        confirmation: { ready: state.confirmed, bookingId: "B1", serviceCode: "grooming", packageName: "Bath & Basic",
          bookingStatus: state.confirmed ? "confirmed" : "payment_pending", paymentId: "P1", paymentMode: "prepaid", paymentStatus: state.captured ? "captured" : "created",
          transactionId: state.captured ? "pay_v2_fixture" : null, amountDueNow: state.captured ? 0 : 1899, totalAmount: 1899, currency: "INR",
          providerId: provider.id, providerName: provider.name, providerModel: provider.model,
          workOrderStatus: state.confirmed ? "assigned" : "payment_pending", scheduledStart: state.booking?.scheduledStart,
          scheduledEnd: state.booking?.scheduledEnd, updatedAt: 1, pets: [{ id: "PET-1", name: "Bruno", species: "dog", breed: "Golden Retriever" }] } });
    }
    if (path === "/api/customer-checkout") {
      if (body.action === "start") {
        state.orderWrites++;
        return reply({ connected: true, status: "awaiting_payment", environment: "sandbox", bookingId: "B1", orderId: "order_v2_fixture",
          // Deliberately short synthetic ID; this API response and the SDK are both test doubles.
          keyId: "rzp_test_v2", amountPaise: 189900, currency: "INR",
          locks: { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" } });
      }
      if (body.action === "confirm") {
        state.captured = true;
        // Real contract: capture can be verified before the complete confirmation projection exists.
        return reply({ bookingId: "B1", orderId: "order_v2_fixture", receiptVerified: true, environment: "sandbox", status: "captured" });
      }
      return reply({ bookingId: "B1", environment: "sandbox", status: state.captured ? "captured" : "awaiting_confirmation" });
    }
    return route.fulfill({ status: 404, json: { error: "Outside the isolated V2 browser contract fixture" } });
  });
  return state;
}
async function selectTickTreatment(page: Page) {
  const disclosure = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Add-ons · add extra services to your grooming/ }) });
  await expect(disclosure).toHaveCount(1);
  if (await disclosure.getAttribute("open") === null) {
    await disclosure.locator("summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
  }
  const checkbox = disclosure.getByRole("checkbox", { name: /Tick & flea treatment/ });
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
}
async function expectReviewTotal(page: Page, value: string) {
  await expect(page.locator("#v2-grooming-summary").getByText(value, { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Running total", exact: true }).getByText(value, { exact: true })).toBeVisible();
}
async function openCare(page: Page) {
  await page.goto("/v2/grooming");
  await expect(page.getByRole("heading", { name: /A calmer spa day/ })).toBeVisible();
  await page.getByLabel("House, street & area").fill("21 Indiranagar Main Road");
  await page.getByLabel("PIN code", { exact: true }).fill("560038");
}
async function previewCare(page: Page) {
  const coverageResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/service-zone" && response.request().method() === "GET");
  await openCare(page);
  expect((await coverageResponse).status()).toBe(200);

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeVisible();
}

test("V2 contract: care -> single booking -> verified capture -> canonical confirmation -> reload", async ({ page }) => {
  const state = await fixture(page), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await previewCare(page);
  await expect(page.getByRole("link", { name: "Close grooming booking" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  // Regress desktop payment text collapsing into the address grid and crossing the CTA.
  const summaryAudit = await page.getByRole("group", { name: "Payment timing" }).evaluate(group => {
    const summary = group.closest("aside")!, outer = summary.getBoundingClientRect();
    const boxes = [...group.children].map(child => child.getBoundingClientRect());
    const buttons = [...group.querySelectorAll("button")];
    const line = (element: Element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      return [...range.getClientRects()].every(rect => rect.left >= outer.left && rect.right <= outer.right && rect.bottom <= outer.bottom);
    };
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
        const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }); return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    };
    const contrast = (element: Element, surface: Element = summary) => {
      const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(surface).backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const captions = [group.querySelector(":scope > small"), ...summary.querySelectorAll('[class*="safe"] p,[class*="footnote"]')].filter(Boolean) as Element[];
    const coupon = summary.querySelector('[role="group"][aria-label="Coupon code"]')!;
    const couponHelper = coupon.querySelector(":scope > small")!;
    const helperStyle = getComputedStyle(couponHelper);
    const helperBounds = couponHelper.getBoundingClientRect();
    return {
      couponHelperContrast: contrast(couponHelper, coupon),
      couponHelperVisible: helperBounds.width > 0 && helperBounds.height > 0 && helperStyle.visibility === "visible" && Number(helperStyle.opacity) > 0,
      stacked: boxes.every((box, i) => i === 0 || box.top >= boxes[i - 1].bottom - 1),
      contained: [...group.querySelectorAll("b,small,strong"), ...captions].every(line),
      choicesFit: buttons.every(button => button.scrollHeight <= button.clientHeight + 1 && button.clientHeight >= 44),
      contrast: captions.map(element => contrast(element)),
    };
  });
  expect(summaryAudit.couponHelperVisible).toBe(true);
  expect(summaryAudit.couponHelperContrast).toBeGreaterThanOrEqual(4.5);
  expect(summaryAudit.stacked).toBe(true);
  expect(summaryAudit.contained).toBe(true);
  expect(summaryAudit.choicesFit).toBe(true);
  expect(summaryAudit.contrast.every(ratio => ratio >= 4.5)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("v2-grooming-care.png"), fullPage: true });
  await page.getByRole("button", { name: /Next · review payment/ }).evaluate(element => {
    (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click();
  });
  await expect(page).toHaveURL(/bookingId=B1/);
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeEnabled();
  expect(state.bookingWrites).toBe(1); expect(state.locationWrites).toBe(1); expect(state.orderWrites).toBe(0);
  await page.getByRole("button", { name: "Pay securely with Razorpay" }).click();
  await expect(page.getByRole("heading", { name: "Payment verified. Finalizing your visit." })).toBeVisible();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeHidden();
  expect(state.orderWrites).toBe(1);
  state.confirmed = true;
  await page.getByRole("button", { name: "Check verified status" }).click();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("pay_v2_fixture", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("v2-grooming-confirmed.png"), fullPage: true });
  await page.reload();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(1); expect(errors).toEqual([]);
});

test("V2 contract: stale coverage cannot verify an edited doorstep", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.coverageGate = new Promise(resolve => { release = resolve; });
  await openCare(page);

  await expect.poll(() => state.coverageStarted).toBe(true);
  await page.getByLabel("PIN code", { exact: true }).fill("560001");
  const settled = page.waitForResponse(response => response.url().includes("/api/service-zone") && response.ok());
  release(); await settled;
  await expect(page.getByText("Bengaluru East is covered")).toBeHidden();
  await expect(page.getByRole("button", { name: /Next · confirm price & groomers/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: delayed provider results cannot restore a stale quote after editing", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.previewGate = new Promise(resolve => { release = resolve; });
  await openCare(page);
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect.poll(() => state.previewStarted).toBe(true);
  await page.getByLabel("House, street & area").fill("42 Indiranagar Different Road");
  const settled = page.waitForResponse(response => response.url().includes("/api/uat-scheduling") && response.ok());
  release(); await settled;
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: address failure preserves booking and blocks payment until recovery", async ({ page }) => {
  const state = await fixture(page); state.locationFailures = 1;
  await previewCare(page); await page.getByRole("button", { name: /Next · review payment/ }).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  await expect(page.getByRole("heading", { name: "Verify the doorstep for this booking" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeDisabled();
  await page.getByRole("button", { name: "Save verified doorstep" }).click();
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeEnabled();
  expect(state.bookingWrites).toBe(1); expect(state.locationWrites).toBe(2); expect(state.orderWrites).toBe(0);
});

test("V2 contract: fallback pricing never enables reservation", async ({ page }) => {
  const state = await fixture(page); state.quoteSource = "fallback_default";
  await openCare(page);
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(page.getByText(/published live grooming price could not be verified/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: unauthorized recovery cannot open a payment", async ({ page }) => {
  const state = await fixture(page); state.unauthorized = true;
  await page.goto("/v2/grooming?bookingId=B1");
  await expect(page.getByRole("alert")).toContainText("Sign in to the customer account");
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeDisabled();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});


test("V2 contract: full-page payment return verifies the receipt, scrubs URL and never creates a new order", async ({ page }) => {
  const state = await fixture(page);
  state.locationReady = true;
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  state.booking = { scheduledStart: `${date}T05:30:00.000Z`, scheduledEnd: `${date}T07:30:00.000Z` };
  const confirmation = page.waitForRequest(request => request.url().endsWith("/api/customer-checkout") &&
    request.method() === "POST" && request.postDataJSON().action === "confirm");
  const signature = "a".repeat(64);
  await page.goto(`/v2/grooming?bookingId=B1&payment=returned&orderId=order_v2_fixture&paymentId=pay_v2_fixture&signature=${signature}`);
  const receipt = (await confirmation).postDataJSON();
  expect(receipt).toMatchObject({ bookingId: "B1", orderId: "order_v2_fixture", paymentId: "pay_v2_fixture", signature });
  await expect(page).toHaveURL(/\/v2\/grooming\?bookingId=B1$/);
  await expect(page.getByRole("heading", { name: "Payment verified. Finalizing your visit." })).toBeVisible();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
  await expect(page.getByRole("button", { name: /do not pay again/ })).toBeDisabled();
  state.confirmed = true;
  await page.getByRole("button", { name: "Check verified status" }).click();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});

test('explicit V2 rejects a contradictory city/PIN before availability or booking', async ({page}) => {
  const state = await fixture(page); await openCare(page);
  await page.getByLabel('House, street & area').fill('24 Audit Road, Mumbai, Maharashtra');

  await expect(page.getByRole('alert')).toContainText('different city');
  await expect(page.getByRole('button',{name:/Next · confirm price & groomers/})).toBeDisabled();
  expect(state.previewStarted).toBe(false); expect(state.bookingWrites).toBe(0);
});
async function familyFixture(page:Page, pets:Array<{id:string;name:string;species:string;ageYears:number}>) {
  const state = await fixture(page);
  await page.route('**/api/customer-account',route=>route.fulfill({json:{data:{
    customerId:'C1',name:'QA Family',primaryPhone:'9000000901',addresses:[],bookings:[],pets,
  }}}));
  await page.goto('/v2/grooming');
  await expect(page.getByRole('heading',{name:/A calmer spa day/})).toBeVisible();
  return state;
}
test('explicit V2 separates puppy and kitten even though both are young pets',async({page})=>{
  const state=await familyFixture(page,[{id:'P1',name:'QA Puppy',species:'dog',ageYears:0.3},{id:'P2',name:'QA Kitten',species:'cat',ageYears:0.3}]);
  await page.getByRole('button',{name:/QA Kitten/}).click();
  await expect(page.getByRole('alert')).toContainText('cannot be mixed');
  await expect(page.getByRole('button',{name:/Next · review payment/})).toBeDisabled();
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});

test('explicit V2 fifth-pet enquiry preserves four pets and never grants consent',async({page})=>{
  const pets=Array.from({length:5},(_,i)=>({id:`P${i+1}`,name:`QA Dog ${i+1}`,species:'dog',ageYears:3}));
  const state=await familyFixture(page,pets);
  for(const pet of pets.slice(1))await page.getByRole('button',{name:new RegExp(pet.name)}).click();
  const enquiry=page.getByRole('dialog',{name:'Large pet family enquiry'});
  await expect(enquiry).toBeVisible();
  await expect(enquiry.locator('select[name="service"]')).toHaveValue('Grooming');
  for(const pet of pets)await expect(enquiry.locator('textarea[name="message"]')).toHaveValue(new RegExp(pet.name));
  await expect(enquiry.locator('input[name="whatsappConsent"]')).not.toBeChecked();
  await enquiry.getByRole('button',{name:'Return to booking'}).click();
  await expect(enquiry).toHaveCount(0);
  for(const pet of pets.slice(0,4))await expect(page.getByRole('button',{name:new RegExp(pet.name)})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:/QA Dog 5/})).toHaveAttribute('aria-pressed','false');
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
test('explicit V2 review retains full address and distinguishes service area from geocoding',async({page})=>{
  await fixture(page);await previewCare(page);
  await expect(page.locator('aside').filter({ hasText: 'YOUR CARE PLAN' })).toContainText('21 Indiranagar Main Road, 560038');
  await expect(page.getByText('Service area matched only. The complete doorstep must still be map-verified before payment.')).toBeVisible();
});


test("G10: four visible keyboard-accessible steps preserve the complete booking draft", async ({ page }) => {
  const state = await fixture(page), requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await openCare(page);
  const navigation = page.getByRole("navigation", { name: "Booking steps" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  for (const button of await navigation.getByRole("button").all()) await expect(button).toBeVisible();
  await expect(navigation.getByRole("button", { name: "4 Time & review" })).toBeDisabled();

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeVisible();
  await page.getByLabel("Notes for your groomer (optional)").fill("Please be gentle with paws");
  const before = [...requests];
  await navigation.getByRole("button", { name: "1 Pets", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#v2-grooming-pets")).toBeFocused();
  await navigation.getByRole("button", { name: "4 Time & review" }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#v2-grooming-time")).toBeFocused();
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(page.getByLabel("PIN code", { exact: true })).toHaveValue("560038");
  await expect(page.getByLabel("Notes for your groomer (optional)")).toHaveValue("Please be gentle with paws");
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  expect(requests).toEqual(before);
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0); expect(state.reservation).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const bounds = await page.locator("[aria-label='Booking steps'], #v2-grooming-pets, #v2-grooming-package, #v2-grooming-address, #v2-grooming-time").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.id || element.getAttribute("aria-label"), x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth };
  }));
  console.log("G10 visible content boundaries", JSON.stringify(bounds));
  for (const box of bounds) {
    expect(box.x, `${box.id} must not be clipped on the left`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${box.id} must not be clipped on the right`).toBeLessThanOrEqual(box.viewport + 1);
  }
  await page.screenshot({ path: test.info().outputPath("g10-four-step-navigation.png"), fullPage: true });
  await page.getByLabel("House, street & area").fill("22 Indiranagar Main Road");
  await expect(navigation.getByRole("button", { name: "4 Time & review" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeDisabled();
});

test("G03: several eligible groomers no longer require manual selection, but customers can change it", async ({ page }) => {
  const state = await fixture(page);
  state.providers = [{ id: "ranked-first", name: "First Ranked Groomer", model: "commission", rating: 4.7 },
    { id: "ranked-second", name: "Second Ranked Groomer", model: "full_time", rating: 4.9 }];
  await previewCare(page);
  const first = page.getByRole("button", { name: /First Ranked Groomer/ });
  const second = page.getByRole("button", { name: /Second Ranked Groomer/ });
  await expect(page.getByRole("button",{name:"PawSpace chooses the best available groomer"})).toHaveAttribute("aria-pressed","true");
  await expect(first).toContainText("Choose"); await expect(second).toContainText("Choose");
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  await second.click(); await expect(second).toContainText("✓"); await expect(first).toContainText("Choose");
  expect(state.bookingWrites).toBe(0); expect(state.reservation).toBeNull();
});

for (const oldValid of [true, false]) test(`G08: late ${oldValid ? "success" : "refusal"} from an old basket cannot replace a fresh coupon`, async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.couponGate = new Promise(resolve => { release = resolve; }); state.couponValid = oldValid;
  await previewCare(page);
  const couponBox = page.getByRole("group", { name: "Coupon code", exact: true });
  await couponBox.getByText("Have a special code?", {exact:true}).click();
  await couponBox.getByRole("textbox").fill("OLD200");
  await couponBox.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => state.couponStarted).toBe(true);
  await page.locator("#v2-grooming-time").getByRole("button").nth(2).click();
  await expect(couponBox).toHaveCount(0);
  state.couponGate = undefined; state.couponValid = true;
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(couponBox).toBeVisible();
  await couponBox.getByText("Have a special code?", {exact:true}).click();
  await couponBox.getByRole("textbox").fill("NEW200");
  await couponBox.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/Coupon NEW200/)).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().includes("/api/coupon-governance") && response.request().postData()?.includes("OLD200") === true);
  release(); await oldResponse;
  // Let the fetch completion and both React paint turns settle before checking the parent's state.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText(/Coupon NEW200/)).toBeVisible();
  await expect(page.getByText(/Coupon OLD200/)).toHaveCount(0);
  await expect(couponBox.getByRole("textbox")).toHaveValue("NEW200");
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});


test("G08: V2 review preserves paise in the discount and payable total", async ({ page }) => {
  const state = await fixture(page); state.couponDiscount = 189.90;
  await previewCare(page);
  const box = page.getByRole("group", { name: "Coupon code", exact: true });
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("PRECISE10");
  await box.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/Coupon PRECISE10/)).toHaveText("Coupon PRECISE10 · −₹189.9");
  await expectReviewTotal(page, "₹1,709.1");
  await expect(page.getByText("₹1,709", { exact: true })).toHaveCount(0);
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});

test("G08: V2 coupon preview and booking refresh use the same basket including extras", async ({page}) => {
  const state = await fixture(page); state.couponDiscount = 239.8;
  await openCare(page);
  await selectTickTreatment(page);

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", {name:/Next · confirm price & groomers/}).click();
  const box=page.getByRole("group", {name:"Coupon code", exact:true});
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("EXTRAS10");
  await box.getByRole("button", {name:"Apply",exact:true}).click();
  await expectReviewTotal(page, "₹2,158.2");
  expect(state.couponInputs.map(input=>input.orderValue)).toEqual([2398]);
  await page.getByRole("button",{name:/Next · review payment/}).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  expect(state.couponInputs.map(input=>input.orderValue)).toEqual([2398,2398]);
  expect(state.booking?.totalAmount).toBe(2158.2); expect(state.booking?.amountDueNow).toBe(2158.2);
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(0);
});

for (const bad of [{discount:100.001,final:1798.999},{discount:100,final:1700}]) test(`G08: malformed coupon money never appears applied: ${bad.discount}/${bad.final}`,async({page})=>{
  const state=await fixture(page); state.couponDiscount=bad.discount; state.couponFinalOverride=bad.final;
  await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("MALFORMED");
  await box.getByRole("button",{name:"Apply",exact:true}).click();
  await expect(box.getByRole("alert")).toHaveText("Reapply the coupon before booking.");
  await expect(page.locator("#v2-grooming-summary").getByText(/^Coupon MALFORMED ·/)).toHaveCount(0);
  await expect(page.getByRole("status", {name:"Running total",exact:true})).toContainText("Coupon MALFORMED needs re-applying");
  await expectReviewTotal(page, "₹1,899");
  await expect(page.getByRole("button", {name:/Next · review payment/})).toBeDisabled();
  expect(state.bookingWrites).toBe(0); expect(state.reservation).toBeNull();
});


test("G11: the best eligible offer applies automatically and can be removed",async({page})=>{
  const state=await fixture(page);state.normalOffers=true;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByRole("heading",{name:"Available offers"})).toBeVisible();
  const size=await box.getByRole("region",{name:"Available offers"}).boundingBox();
  expect(size?.width).toBeGreaterThan(180);
  expect(size?.height).toBeLessThan(500);

  await expect(box.getByRole("textbox")).toBeHidden();
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  await expect(box.getByRole("button",{name:"Apply NORMAL",exact:true})).toBeDisabled();
  expect(state.couponInputs.at(-1)?.code).toBe("NORMAL");
  await box.getByRole("button",{name:"Remove coupon"}).click();
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
  await page.screenshot({path:test.info().outputPath("g11-available-offers.png"),fullPage:true});
});
test("G12/G14: fourth booking hides normal offers but retains separate special-code entry",async({page})=>{
  const state=await fixture(page);state.normalOffers=true;state.bookingCount=3;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByText(/first three bookings/)).toBeVisible();
  await expect(box.getByRole("button",{name:"Apply NORMAL"})).toHaveCount(0);
  await box.getByText("Have a special code?",{exact:true}).click();
  await box.getByRole("textbox").fill("PRIVATE");await box.getByRole("button",{name:"Apply",exact:true}).click();
  await expect(page.getByText(/Coupon PRIVATE/)).toBeVisible();
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
for (const refusal of [
  {name:"server refusal",valid:false,discount:200,message:"The previous coupon is no longer available"},
  {name:"malformed money",valid:true,discount:100.001,message:"Reapply the coupon before booking."},
]) test(`G11: automatic ${refusal.name} remains blocked and can be explicitly removed`,async({page})=>{
  const state=await fixture(page);state.normalOffers=true;state.couponValid=refusal.valid;state.couponDiscount=refusal.discount;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByRole("status").filter({hasText:refusal.message})).toHaveText(refusal.message);
  await expect(box.getByRole("alert")).toContainText("Offer NORMAL is no longer applied");
  await expect(box.getByRole("textbox")).toBeHidden();
  await expect(box.getByRole("button",{name:"Remove coupon"})).toBeVisible();
  await expect(page.locator("#v2-grooming-summary").getByText(/^Coupon NORMAL ·/)).toHaveCount(0);
  await expect(box.getByText(/applied to this booking/)).toHaveCount(0);
  await expect(page.getByRole("button",{name:/Next · review payment/})).toBeDisabled();
  await box.getByRole("button",{name:"Remove coupon"}).click();
  await expect(page.getByRole("button",{name:/Next · review payment/})).toBeEnabled();
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
test("G11: offer lookup failure stays honest and supports retry without applying anything",async({page})=>{
  const state=await fixture(page);state.normalOffers=true;state.offersUnavailable=true;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByText(/temporarily unavailable/)).toBeVisible();
  await expect(box.getByRole("button",{name:"Apply NORMAL"})).toHaveCount(0);state.offersUnavailable=false;
  await box.getByRole("button",{name:"Retry offers"}).click();await expect(box.getByRole("button",{name:"Apply NORMAL"})).toBeVisible();
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();expect(state.couponInputs).toHaveLength(1);expect(state.bookingWrites).toBe(0);
});

test("V2 auto groomer choice accepts a new server match and names that person on the booking",async({page})=>{
 const state=await fixture(page);await previewCare(page);
 state.assignedProvider={id:"PRV-REPLACEMENT",name:"Replacement Groomer",model:"commission",rating:4.8};
 await page.getByRole("button",{name:/Next · review payment/}).click();
 await expect(page).toHaveURL(/bookingId=B1/);
 expect(state.reservation?.providerSelection).toBe("auto");expect(state.reservation?.preferredProviderId).toBeUndefined();
 expect(state.booking?.provider).toMatchObject({id:"PRV-REPLACEMENT",name:"Replacement Groomer"});
 expect(state.bookingWrites).toBe(1);expect(state.orderWrites).toBe(0);
});
test("V2 specific groomer selection never silently uses a replacement",async({page})=>{
 const state=await fixture(page);await previewCare(page);
 expect(await chooseFirstNamedGroomer(page)).toBe("Arjun - PawSpace Care");
 state.reserveRefusal="SELECTED_PROVIDER_UNAVAILABLE";
 await page.getByRole("button",{name:/Next · review payment/}).click();
 await expect(page.getByRole("alert")).toContainText("selected provider");
 expect(state.reservation?.providerSelection).toBe("specific");expect(state.reservation?.preferredProviderId).toBe("PRV1");
 expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
 await expect(page.getByRole("button",{name:/Arjun - PawSpace Care/})).toHaveAttribute("aria-pressed","true");
});

test("V2 automatic matching preserves the staged extras and coupon payable", async ({page}) => {
  const state = await fixture(page); state.couponDiscount = 239.8;
  await openCare(page);
  await selectTickTreatment(page);

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", {name:/Next · confirm price & groomers/}).click();
  const coupon = page.getByRole("group", {name:"Coupon code", exact:true});
  await coupon.getByText("Have a special code?", {exact:true}).click();
  await coupon.getByRole("textbox").fill("EXTRAS10");
  await coupon.getByRole("button", {name:"Apply", exact:true}).click();
  await expectReviewTotal(page, "₹2,158.2");
  state.assignedProvider = {id:"PRV-CURRENT",name:"Current Eligible Groomer",model:"commission",rating:4.8};
  await page.getByRole("button", {name:/Next · review payment/}).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  expect(state.reservation?.providerSelection).toBe("auto");
  expect(state.reservation?.preferredProviderId).toBeUndefined();
  expect(state.booking?.provider).toMatchObject({id:"PRV-CURRENT"});
  expect(state.couponInputs.map(input=>input.orderValue)).toEqual([2398,2398]);
  expect(state.booking?.totalAmount).toBe(2158.2);
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(0);
});


test("G09: a delayed offer lookup cannot overwrite a customer-entered special coupon",async({page})=>{
 const state=await fixture(page);state.normalOffers=true;
 let release!:()=>void;state.offerGate=new Promise(resolve=>{release=resolve;});
 await previewCare(page);const box=page.getByRole("group",{name:"Coupon code",exact:true});
 await expect.poll(()=>state.offerReads||0).toBe(1);
 await expect(page.getByRole("button",{name:/Next · review payment/})).toBeDisabled();
 await box.getByText("Have a special code?",{exact:true}).click();await box.getByRole("textbox").fill("PRIVATE");
 await box.getByRole("button",{name:"Apply",exact:true}).click();await expect(page.getByText(/Coupon PRIVATE/)).toBeVisible();
 release();await expect(box.getByRole("button",{name:"Apply NORMAL",exact:true})).toBeVisible();
 expect(state.couponInputs.map(x=>x.code)).toEqual(["PRIVATE"]);await expect(page.getByText(/Coupon PRIVATE/)).toBeVisible();
});
test("G09: Remove cancels a pending automatic quote and survives a fresh price check",async({page})=>{
 const state=await fixture(page);state.normalOffers=true;let release!:()=>void;
 state.couponGate=new Promise(resolve=>{release=resolve;});await previewCare(page);
 const box=page.getByRole("group",{name:"Coupon code",exact:true});await expect.poll(()=>state.couponStarted).toBe(true);
 await expect(page.getByRole("button",{name:/Next · review payment/})).toBeDisabled();
 await box.getByRole("button",{name:"Remove coupon"}).click();release();state.couponGate=undefined;
 await expect(page.getByRole("button",{name:/Next · review payment/})).toBeEnabled();
 await page.getByRole("button",{name:/Next · confirm price & groomers/}).click();
 await expect.poll(()=>state.offerReads||0).toBe(2);
 await expect(box.getByRole("button",{name:"Apply NORMAL",exact:true})).toBeEnabled();
 await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);expect(state.couponInputs).toHaveLength(1);
});
test("G09: a customer's chosen offer is revalidated instead of replaced by a larger default",async({page})=>{
 const state=await fixture(page);state.normalOffers=true;state.offerValues=[{code:"NORMAL",savings:300},{code:"SECOND",savings:100}];state.couponDiscounts={NORMAL:300,SECOND:100};
 await previewCare(page);const box=page.getByRole("group",{name:"Coupon code",exact:true});
 await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
 await box.getByRole("button",{name:"Apply SECOND",exact:true}).click();await expect(page.getByText(/Coupon SECOND/)).toBeVisible();
 await selectTickTreatment(page);
 await page.getByRole("button",{name:/Next · confirm price & groomers/}).click();
 await expectReviewTotal(page, "₹2,298");
 expect(state.couponInputs.map(x=>x.code)).toEqual(["NORMAL","SECOND","SECOND"]);
 expect(state.couponInputs.at(-1)?.orderValue).toBe(2398);expect(state.bookingWrites).toBe(0);
});
test("G09: automatic selection recomputes the best savings for the changed basket",async({page})=>{
 const state=await fixture(page);state.normalOffers=true;await previewCare(page);
 await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
 state.offerValues=[{code:"BETTER",savings:350},{code:"NORMAL",savings:200}];state.couponDiscounts={BETTER:350};
 await selectTickTreatment(page);
 await page.getByRole("button",{name:/Next · confirm price & groomers/}).click();
 await expect(page.getByText(/Coupon BETTER/)).toBeVisible();await expectReviewTotal(page, "₹2,048");
 expect(state.couponInputs.map(x=>x.code)).toEqual(["NORMAL","BETTER"]);
});
test("G09: losing eligibility on a changed basket cannot silently enable full-price checkout",async({page})=>{
 const state=await fixture(page);state.normalOffers=true;await previewCare(page);
 await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();state.bookingCount=3;
 await selectTickTreatment(page);
 await page.getByRole("button",{name:/Next · confirm price & groomers/}).click();
 const box=page.getByRole("group",{name:"Coupon code",exact:true});await expect(box.getByRole("alert")).toContainText("no longer matches");
 await expect(page.getByRole("button",{name:/Next · review payment/})).toBeDisabled();
 await box.getByRole("button",{name:"Remove coupon"}).click();await expect(page.getByRole("button",{name:/Next · review payment/})).toBeEnabled();
 expect(state.couponInputs).toHaveLength(1);expect(state.bookingWrites).toBe(0);
});


test("G09: typing a private code is not treated as consent to apply it on a new basket",async({page})=>{
 const state=await fixture(page);await previewCare(page);const box=page.getByRole("group",{name:"Coupon code",exact:true});
 await box.getByText("Have a special code?",{exact:true}).click();await box.getByRole("textbox").fill("PRIVATE");
 await selectTickTreatment(page);await page.getByRole("button",{name:/Next · confirm price & groomers/}).click();
 await expect.poll(()=>state.offerReads||0).toBe(2);
 await expect(page.getByRole("button",{name:/Next · review payment/})).toBeDisabled();
 await box.getByText("Have a special code?",{exact:true}).click();await expect(box.getByRole("textbox")).toHaveValue("PRIVATE");
 expect(state.couponInputs).toHaveLength(0);await box.getByRole("button",{name:"Apply",exact:true}).click();
 await expect(page.getByText(/Coupon PRIVATE/)).toBeVisible();expect(state.couponInputs).toHaveLength(1);
});


const locatedAddress = "42 Indiranagar Double Road, Bengaluru 560038";
async function enableDeviceLocation(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 12.9783692, longitude: 77.6408356 });
}
function noLocationMutations(state: Fixture) {
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
  expect(state.locationWrites).toBe(0); expect(state.reservation).toBeNull();
}

async function deviceLocationReview(page: Page) {
  const review = page.getByRole("group", { name: "Current location", exact: true });
  // The Google-capable picker has its own location action. Exercise the retained
  // review/cancel path through its actual disclosure rather than that other button.
  if (!await review.isVisible()) await page.getByText("Use device location instead", { exact: true }).click();
  await expect(review).toBeVisible();
  return review;
}

test("G02/G05: location needs a user action and review; confirmed changes recheck the booking", async ({ page }) => {
  const state = await fixture(page); state.normalOffers = true; await enableDeviceLocation(page);
  await previewCare(page);
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  expect(state.reverseCalls).toBe(0);
  const reserve = page.getByRole("button", { name: /Next · review payment/ });
  await expect(reserve).toBeEnabled();
  await (await deviceLocationReview(page)).getByRole("button", { name: "Use current location", exact: true }).click();
  const suggested = page.getByRole("region", { name: "Suggested service address" });
  await expect(suggested).toBeVisible();
  await expect(suggested).toContainText(locatedAddress);
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(reserve).toBeDisabled();
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  const bounds = await page.getByRole("group", { name: "Current location", exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: test.info().outputPath("g02-location-review.png"), fullPage: true });
  await suggested.getByRole("button", { name: "Use suggested address" }).click();
  await expect(page.getByLabel("House, street & area")).toHaveValue(locatedAddress);
  await expect(page.getByLabel("House, street & area")).toBeFocused();
  await expect(page.getByLabel("PIN code", { exact: true })).toHaveValue("560038");
  await expect(page.getByText("Bengaluru East is covered")).toHaveCount(0);
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toHaveCount(0);
  await expect(page.getByLabel("Save this address to my account")).not.toBeChecked();
  await expect(reserve).toBeDisabled();
  await page.getByLabel("House, street & area").fill(`Flat 4, ${locatedAddress}`);

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible(); await expect(reserve).toBeEnabled();
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain("12.9783692"); expect(stored).not.toContain("77.6408356");
  expect(state.reverseCalls).toBe(1); noLocationMutations(state);
});

for (const code of [1, 3]) test(`G02: device refusal ${code} preserves entered address and manual fallback`, async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(value => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition(_success: unknown, fail: (error: { code: number }) => void) { fail({ code: value }); },
    } });
  }, code);
  await previewCare(page);
  await (await deviceLocationReview(page)).getByRole("button", { name: "Use current location", exact: true }).click();
  await expect(page.getByRole("group", { name: "Current location", exact: true }).getByRole("alert")).toContainText("manually");
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  expect(state.reverseCalls).toBe(0);
  await page.getByRole("button", { name: "Enter address manually", exact: true }).click();
  await expect(page.getByLabel("House, street & area")).toBeFocused(); noLocationMutations(state);
});

test("G02: cancelling a delayed reverse lookup cannot overwrite a later typed address", async ({ page }) => {
  const state = await fixture(page); await enableDeviceLocation(page);
  let release!: () => void; state.reverseGate = new Promise(resolve => { release = resolve; });
  await previewCare(page);
  await (await deviceLocationReview(page)).getByRole("button", { name: "Use current location", exact: true }).click();
  await expect.poll(() => state.reverseCalls).toBe(1);
  await page.getByRole("button", { name: "Cancel location lookup", exact: true }).click();
  await page.getByLabel("House, street & area").fill("99 Indiranagar Main Road");
  release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole("region", { name: "Suggested service address" })).toHaveCount(0);
  await expect(page.getByLabel("House, street & area")).toHaveValue("99 Indiranagar Main Road");
  noLocationMutations(state);
});

test("G02: late device permission completion after manual entry never calls the map API", async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition(success: (position: unknown) => void) {
        (window as unknown as { finishLocation: () => void }).finishLocation = () => success({ coords: { latitude: 12.9783692, longitude: 77.6408356 } });
      },
    } });
  });
  await openCare(page);
  await (await deviceLocationReview(page)).getByRole("button", { name: "Use current location", exact: true }).click();
  await page.getByRole("button", { name: "Enter address manually", exact: true }).click();
  await page.getByLabel("House, street & area").fill("99 Indiranagar Main Road");
  await page.evaluate(() => (window as unknown as { finishLocation: () => void }).finishLocation());
  await expect(page.getByLabel("House, street & area")).toHaveValue("99 Indiranagar Main Road");
  expect(state.reverseCalls).toBe(0); noLocationMutations(state);
});

test("G02: rejecting a suggested location keeps the existing quote and coupon intact", async ({ page }) => {
  const state = await fixture(page); state.normalOffers = true; await enableDeviceLocation(page);
  await previewCare(page); await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  await (await deviceLocationReview(page)).getByRole("button", { name: "Use current location", exact: true }).click();
  await page.getByRole("button", { name: "Keep entered address", exact: true }).click();
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  noLocationMutations(state);
});

test("G05: Change address preserves the care draft and the customer's removed-coupon decision", async ({ page }) => {
  const state = await fixture(page); state.normalOffers = true; await previewCare(page);
  await page.getByLabel("Notes for your groomer (optional)").fill("Please be gentle with paws");
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  await page.getByRole("button", { name: "Remove coupon", exact: true }).click();
  await page.getByRole("button", { name: "Change address", exact: true }).click();
  await expect(page.getByLabel("House, street & area")).toBeFocused();
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(page.getByLabel("Notes for your groomer (optional)")).toHaveValue("Please be gentle with paws");
  await expect(page.getByText("Bengaluru East is covered")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeDisabled();
  await page.getByLabel("House, street & area").fill("99 Indiranagar Main Road");

  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Next · confirm price & groomers/ }).click();
  await expect(page.getByRole("button", { name: /Next · review payment/ })).toBeEnabled();
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0); noLocationMutations(state);
});


test("R05 named groomer helper skips automatic matching and preserves the exact reservation", async ({ page }) => {
  const state = await fixture(page); await previewCare(page);
  await expect(page.getByRole("button", { name: "PawSpace chooses the best available groomer", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(await chooseFirstNamedGroomer(page)).toBe("Arjun - PawSpace Care");
  expect(state.reservation).toBeNull();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
  await page.getByRole("button", { name: /Next · review payment/ }).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  expect(state.reservation?.providerSelection).toBe("specific");
  expect(state.reservation?.preferredProviderId).toBe("PRV1");
  expect(state.booking?.provider).toMatchObject({ id: "PRV1", name: "Arjun - PawSpace Care" });
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(0);
});
