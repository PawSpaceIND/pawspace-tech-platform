import { test, expect, type Page } from "@playwright/test";

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

function noLocationMutations(state: Fixture) {
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
  expect(state.locationWrites).toBe(0); expect(state.reservation).toBeNull();
}

async function deviceLocationReview(page: Page) {
  const essentialOnly = page.getByRole("button", { name: "Essential Only" });
  if (await essentialOnly.isVisible()) await essentialOnly.click();
  const disclosure = page.locator("details").filter({ has: page.locator("summary", { hasText: "Use device location instead" }) });
  if (await disclosure.getAttribute("open") === null) {
    await disclosure.locator("summary").focus();
    await disclosure.locator("summary").press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
  }
  const review = page.getByRole("group", { name: "Current location", exact: true });
  // The Google-capable picker has its own location action. Exercise the retained
  // review/cancel path through its actual disclosure rather than that other button.
  await expect(review).toBeVisible();
  return review;
}

test.afterEach(async ({page},info)=>{const evidence=await page.evaluate(()=>({events:(window as any).__pointerEvents,geoCalls:(window as any).__geoCalls})).catch(()=>null);await info.attach('native-input-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});});
async function passive(page:Page){await page.addInitScript(()=>{
 (window as any).__pointerEvents=[];(window as any).__geoCalls=0;
 const label=(e:EventTarget|null)=>e instanceof Element?`${e.tagName}#${e.id}:${e.textContent?.trim().slice(0,100)}`:String(e);
 for(const type of ['pointerdown','mousedown','mouseup','click','touchstart','touchend','focusin'])document.addEventListener(type,event=>{
  const e=event as MouseEvent,button=(event.target as Element)?.closest?.('button'),r=button?.getBoundingClientRect();
  const entry={type,t:performance.now(),trusted:event.isTrusted,target:label(event.target),hit:label(document.elementFromPoint(e.clientX||0,e.clientY||0)),scrollY,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,prevented:event.defaultPrevented};
  (window as any).__pointerEvents.push(entry);queueMicrotask(()=>entry.prevented=event.defaultPrevented);
 },true);
 // Capture-phase microtasks can run before React's root capture handler. Measure
 // cancellation at document bubble, after the source handler, without altering input.
 document.addEventListener('mousedown',event=>{
  const entries=(window as any).__pointerEvents;const entry=[...entries].reverse().find(e=>e.type==='mousedown');
  if(entry){entry.capturePrevented=entry.prevented;entry.prevented=event.defaultPrevented;entry.bubbleObserved=true;}
 });
 Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(_success:unknown,fail:(e:{code:number})=>void){(window as any).__geoCalls++;queueMicrotask(()=>fail({code:1}));}}});
});}
async function nativeDown(page:Page,button:ReturnType<Page['getByRole']>,secondary=false){
 await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down({button:secondary?'right':'left'});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 return box!;
}
async function events(page:Page){return page.evaluate(()=>(window as any).__pointerEvents as Array<{type:string;target:string;prevented:boolean;trusted:boolean}>);}

test('POINTER focused: held Change address retains privacy setup, care and removed coupon',async({page})=>{
 const state=await fixture(page);state.normalOffers=true;await passive(page);await previewCare(page);
 await page.getByLabel('Notes for your groomer (optional)').fill('Please be gentle with paws');
 await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();await page.getByRole('button',{name:'Remove coupon',exact:true}).click();
 const action=page.getByRole('button',{name:'Change address',exact:true});
 await page.evaluate(()=>(window as any).__pointerEvents=[]);const before=await nativeDown(page,action);
 await expect(page.getByText('Bengaluru East is covered')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(0);
 const after=await action.boundingBox();expect(after).not.toBeNull();expect(Math.abs(after!.y-before.y)).toBeLessThanOrEqual(1);
 await page.mouse.up();
 await expect(page.getByLabel('House, street & area')).toBeFocused();
 await expect(page.getByLabel('House, street & area')).toHaveValue('21 Indiranagar Main Road');
 await expect(page.getByLabel('Notes for your groomer (optional)')).toHaveValue('Please be gentle with paws');
 await expect(page.getByText('Bengaluru East is covered')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Next · review payment/})).toBeDisabled();
 const timeline=await events(page);expect(timeline.find(e=>e.type==='mousedown'&&e.target.includes('Change address'))?.prevented).toBe(true);
 expect(timeline.find(e=>e.type==='click'&&e.target.includes('Change address'))?.trusted).toBe(true);
 await page.getByLabel('House, street & area').fill('99 Indiranagar Main Road');await expect(page.getByText('Bengaluru East is covered')).toBeVisible();
 await page.getByRole('button',{name:/Next · confirm price & groomers/}).click();await expect(page.getByRole('button',{name:/Next · review payment/})).toBeEnabled();
 await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);noLocationMutations(state);
});

test('POINTER focused: held location starts once on click, never on down',async({page})=>{
 const state=await fixture(page);await passive(page);await previewCare(page);const review=await deviceLocationReview(page);
 const action=review.getByRole('button',{name:'Use current location',exact:true});await page.evaluate(()=>(window as any).__pointerEvents=[]);
 await nativeDown(page,action);expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(0);expect(state.reverseCalls).toBe(0);
 await page.mouse.up();await expect(review.getByRole('alert')).toContainText('manually');expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(1);
 const timeline=await events(page);expect(timeline.find(e=>e.type==='mousedown'&&e.target.includes('Use current location'))?.prevented).toBe(true);expect(timeline.find(e=>e.type==='click'&&e.target.includes('Use current location'))?.trusted).toBe(true);
 await expect(page.getByLabel('House, street & area')).toHaveValue('21 Indiranagar Main Road');noLocationMutations(state);
});

test('POINTER focused: address keyboard Enter and Space retain normal activation',async({page})=>{
 const state=await fixture(page);await passive(page);await previewCare(page);const review=await deviceLocationReview(page);const action=review.getByRole('button',{name:'Use current location',exact:true});
 for(const [index,key]of ['Enter','Space'].entries()){
  await page.keyboard.press('Tab');
  for(let n=0;n<60&&!await action.evaluate(e=>document.activeElement===e);n++)await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await page.keyboard.press(key);await expect(review.getByRole('alert')).toContainText('manually');expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(index+1);
 }
 await expect(page.getByLabel('House, street & area')).toHaveValue('21 Indiranagar Main Road');expect(state.reverseCalls).toBe(0);noLocationMutations(state);
});

test('POINTER focused: disabled fieldset, contact and secondary input stay excluded',async({page})=>{
 const state=await fixture(page);await passive(page);await previewCare(page);
 // Isolated DOM exclusion control only; no checkout/reservation is created to disable the picker.
 const fieldset=page.locator('#v2-grooming-address fieldset');await fieldset.evaluate(e=>(e as HTMLFieldSetElement).disabled=true);
 const disabled=fieldset.getByRole('button',{name:'Use current location',exact:true});await expect(disabled).toBeDisabled();await disabled.scrollIntoViewIfNeeded();const box=await disabled.boundingBox();expect(box).not.toBeNull();
 await page.mouse.click(box!.x+box!.width/2,box!.y+box!.height/2);expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(0);
 await fieldset.evaluate(e=>(e as HTMLFieldSetElement).disabled=false);
 const contact=page.locator('section[aria-label="Contact details"]');const edit=contact.getByRole('button',{name:'Edit details',exact:true});await page.evaluate(()=>(window as any).__pointerEvents=[]);
 await edit.click();await expect(contact.getByLabel('Name',{exact:true})).toBeVisible();expect((await events(page)).find(e=>e.type==='mousedown'&&e.target.includes('Edit details'))?.prevented).toBe(false);
 await contact.getByRole('button',{name:'Close editing',exact:true}).click();const review=await deviceLocationReview(page);await nativeDown(page,review.getByRole('button',{name:'Use current location',exact:true}),true);await page.mouse.up({button:'right'});
 expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(0);expect(state.reverseCalls).toBe(0);noLocationMutations(state);
});

test('POINTER focused: native touch edit and location activation preserve state',async({page})=>{
 const state=await fixture(page);await passive(page);await previewCare(page);
 await page.getByLabel('Notes for your groomer (optional)').fill('Touch care remains');
 const change=page.getByRole('button',{name:'Change address',exact:true});await change.tap();
 await expect(page.getByLabel('House, street & area')).toBeFocused();await expect(page.getByLabel('House, street & area')).toHaveValue('21 Indiranagar Main Road');
 await expect(page.getByLabel('Notes for your groomer (optional)')).toHaveValue('Touch care remains');
 const review=await deviceLocationReview(page);await review.getByRole('button',{name:'Use current location',exact:true}).tap();
 await expect(review.getByRole('alert')).toContainText('manually');expect(await page.evaluate(()=>(window as any).__geoCalls)).toBe(1);
 expect((await events(page)).some(e=>e.type==='touchstart'&&e.trusted)).toBe(true);expect(state.reverseCalls).toBe(0);noLocationMutations(state);
});
