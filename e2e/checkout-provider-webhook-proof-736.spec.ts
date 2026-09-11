import { test, expect, type Page } from "@playwright/test";

let ORIGIN = "";
let WORKER = "";
const CANDIDATE = String(process.env.CHECKOUT_CANDIDATE_SHA || "").trim();
const PHONE = "9000000736";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const RZP_KEY = process.env.RAZORPAY_KEY_ID_SANDBOX || "";
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET_SANDBOX || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const UAT_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
const PRECHECK_ONLY = process.env.PR736_PRECHECK_ONLY === "true";
// Provider/D1 payloads are intentionally schemaless at this external test boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function cf(path: string, init: RequestInit = {}) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${CF_TOKEN}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = (await response.json()) as Json;
  if (!response.ok || body.success !== true)
    throw new Error(`Cloudflare request failed (${response.status})`);
  return body.result;
}
async function isolatedDbId() {
  for (let page = 1; page <= 10; page++) {
    const rows = (await cf(`/d1/database?per_page=100&page=${page}`)) as Json[];
    const hit = rows.find((row) => row.name === WORKER);
    if (hit?.uuid) return String(hit.uuid);
    if (!rows.length) break;
  }
  throw new Error("Isolated checkout database was not found");
}

async function d1(dbId: string, sql: string, params: unknown[] = []) {
  const result = (await cf(`/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  })) as Array<{ results?: Json[] }>;
  return result?.[0]?.results || [];
}

type RelayIdentity = {
  origin: string;
  worker: string;
  candidateSha: string;
  stagingDeploymentId: string;
};

async function stagingRelayIdentity(): Promise<RelayIdentity> {
  const [staging, deployments] = await Promise.all([
    cf("/workers/scripts/pawspace-staging/settings") as Promise<Json>,
    cf("/workers/scripts/pawspace-staging/deployments") as Promise<Json>,
  ]);
  const bindings = Array.isArray(staging.bindings) ? staging.bindings : [];
  const plain = Object.fromEntries(
    bindings
      .filter((b: Json) => b.type === "plain_text")
      .map((b: Json) => [String(b.name), String(b.text ?? b.value ?? "")]),
  );
  expect(plain.PAWSPACE_DEPLOYMENT_ENV).toBe("staging");
  expect(plain.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(
    String(plain.PAWSPACE_PAYMENT_LIVE_APPROVED || "false").toLowerCase(),
  ).not.toBe("true");
  const origin = String(
    plain.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN || "",
  ).replace(/\/$/, "");
  const candidateSha = String(
    plain.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA || "",
  );
  expect(candidateSha).toBe(CANDIDATE);
  const target = new URL(origin);
  expect(target.protocol).toBe("https:");
  expect(
    target.username ||
      target.password ||
      target.port ||
      target.search ||
      target.hash,
  ).toBe("");
  expect(["", "/"]).toContain(target.pathname);
  expect(target.hostname).toMatch(
    /^pawspace-checkout-736-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}\.[a-z0-9-]+\.workers\.dev$/i,
  );
  const worker = target.hostname.split(".")[0];
  const service = bindings.find(
    (b: Json) => b.name === "PAWSPACE_RAZORPAY_SANDBOX_RELAY_SERVICE",
  );
  expect(
    service,
    "Staging must carry the exact PR736 relay service binding",
  ).toBeTruthy();
  expect(String(service?.type || "")).toMatch(/service/i);
  expect(String(service?.service || service?.service_name || "")).toBe(worker);
  const webhook = bindings.find(
    (b: Json) => b.name === "RAZORPAY_WEBHOOK_SECRET_SANDBOX",
  );
  expect(String(webhook?.type || "")).toMatch(/secret/i);
  const stagingDb = bindings.find(
    (b: Json) => b.type === "d1" && b.name === "DB",
  );
  expect(stagingDb?.id).toBeTruthy();
  const active = deployments?.deployments?.[0];
  expect(active?.id).toBeTruthy();
  expect(active?.versions).toHaveLength(1);
  expect(Number(active.versions[0]?.percentage)).toBe(100);
  return {
    origin,
    worker,
    candidateSha,
    stagingDeploymentId: String(active.id),
  };
}

async function assertStagingRelayStable(expected: RelayIdentity) {
  const current = await stagingRelayIdentity();
  expect(current, "Staging relay changed during the payment proof").toEqual(
    expected,
  );
}

async function revalidateTarget() {
  const pr = await fetch(
    "https://api.github.com/repos/PawSpaceIND/pawspace-tech-platform/pulls/736",
    {
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    },
  );
  expect(pr.status).toBe(200);
  const prBody = (await pr.json()) as Json;
  expect(prBody.state).toBe("closed");
  expect(prBody.merged).toBe(true);
  expect(prBody.head?.sha).toBe(CANDIDATE);
  expect(prBody.head?.ref).toBe(
    "test/razorpay-recon-untrusted-evidence-20260911",
  );
  expect(prBody.head?.repo?.full_name).toBe(
    "PawSpaceIND/pawspace-tech-platform",
  );

  const relay = await stagingRelayIdentity();
  ORIGIN = relay.origin;
  WORKER = relay.worker;
  const [settings, deployments] = await Promise.all([
    cf(`/workers/scripts/${WORKER}/settings`) as Promise<Json>,
    cf(`/workers/scripts/${WORKER}/deployments`) as Promise<Json>,
  ]);
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const plain = Object.fromEntries(
    bindings
      .filter((b: Json) => b.type === "plain_text")
      .map((b: Json) => [String(b.name), String(b.text ?? b.value ?? "")]),
  );
  expect(WORKER).toMatch(
    /^pawspace-checkout-736-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/,
  );
  expect(plain.PAWSPACE_DEPLOYMENT_ENV).toBe("checkout-sandbox");
  expect(plain.PAWSPACE_ENVIRONMENT).toBe("checkout-sandbox");
  expect(plain.PAWSPACE_RELEASE_SHA).toBe(CANDIDATE);
  expect(plain.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(plain.FORBID_PRODUCTION).toBe("true");
  expect(plain.PAWSPACE_UAT_LOGIN).toBe("on");
  for (const name of [
    "PAWSPACE_PAYMENT_LIVE_APPROVED",
    "PAWSPACE_LIVE_PAYMENTS",
    "PAWSPACE_LIVE_REFUNDS",
    "PAWSPACE_LIVE_PAYOUTS",
    "PAWSPACE_RAZORPAYX_LIVE_APPROVED",
  ]) {
    expect(
      String(plain[name] || "false").toLowerCase(),
      `${name} must not enable live money`,
    ).not.toBe("true");
  }
  const webhook = bindings.find(
    (b: Json) => b.name === "RAZORPAY_WEBHOOK_SECRET_SANDBOX",
  );
  expect(String(webhook?.type || "")).toMatch(/secret/i);
  const dbBindings = bindings.filter(
    (b: Json) => b.type === "d1" && b.name === "DB",
  );
  expect(dbBindings).toHaveLength(1);
  const active = deployments?.deployments?.[0];
  expect(active?.id).toBeTruthy();
  expect(active?.versions).toHaveLength(1);
  expect(Number(active.versions[0]?.percentage)).toBe(100);
  expect(settings?.annotations?.["workers/message"]).toBe(
    `checkout-sandbox ${CANDIDATE}`,
  );
  const dbId = await isolatedDbId();
  expect(String(dbBindings[0].id || "").toLowerCase()).toBe(dbId.toLowerCase());

  const staging = (await cf(
    "/workers/scripts/pawspace-staging/settings",
  )) as Json;
  const stagingDb = (
    Array.isArray(staging.bindings) ? staging.bindings : []
  ).find((b: Json) => b.type === "d1" && b.name === "DB");
  expect(String(stagingDb?.id || "").toLowerCase()).not.toBe(
    dbId.toLowerCase(),
  );
  return { dbId, relay };
}

async function rzp(path: string) {
  const auth = Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com${path}`, {
    headers: { authorization: `Basic ${auth}` },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as Json;
  if (!response.ok)
    throw new Error(`Razorpay provider read failed (${response.status})`);
  return body;
}

async function pagePost(page: Page, path: string, body: Json) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}

async function createProductNativePayableBooking(
  page: Page,
  customerId: string,
  coupon?: {
    quoteId: string;
    code: string;
    discount: number;
    finalAmount: number;
  },
) {
  const stamp = Date.now();
  const sourcePetId = `pr736-product-native-${stamp}`;
  const groupId = `PR736-PRODUCT-GRP-${stamp}`;
  const bookingKey = `pr736-product-native:${stamp}`;
  const startAt = new Date(stamp + 12 * 86_400_000);
  startAt.setUTCHours(9, 0, 0, 0);
  const endAt = new Date(startAt.getTime() + 120 * 60_000);
  const scheduledStart = startAt.toISOString();
  const scheduledEnd = endAt.toISOString();

  const pet = await pagePost(page, "/api/customer-account", {
    action: "upsert_pet",
    idempotencyKey: `pr736-product-pet:${stamp}`,
    pet: {
      sourceId: sourcePetId,
      name: "Provider Proof Dog",
      species: "dog",
      breed: "Indie",
      vaccinationStatus: "verified",
      ageYears: 3,
      weightKg: 15,
    },
  });
  expect(
    [200, 201],
    `Saved-pet write failed: ${JSON.stringify(pet.body)}`,
  ).toContain(pet.status);
  const petId = String(pet.body?.data?.entityId || "");
  expect(petId).toMatch(/^PET-/);

  const schedule = await pagePost(page, "/api/uat-scheduling", {
    clientRequestId: groupId,
    customerId,
    petIds: [petId],
    serviceCode: "grooming",
    serviceAddress: "PawSpace sandbox service-discovery fixture, Indiranagar",
    servicePincode: "560038",
    scheduledStart,
    scheduledEnd,
    occurrences: 1,
    assignmentStrategy: "auto",
  });
  expect(
    schedule.status,
    `Scheduling failed: ${JSON.stringify(schedule.body)}`,
  ).toBe(200);
  expect(schedule.body?.data?.status).toBe("assigned");
  const provider = schedule.body?.data?.provider as Json;
  expect(String(provider?.id || "")).toBeTruthy();
  expect(["full_time", "commission"]).toContain(String(provider?.model || ""));
  const cityId = String(schedule.body?.data?.addressAuthority?.cityId || "");
  const zoneId = String(schedule.body?.data?.addressAuthority?.zoneId || "");
  expect(cityId).toBe("blr");
  expect(zoneId).toBeTruthy();

  const booking = await pagePost(page, "/api/canonical-bookings", {
    idempotencyKey: bookingKey,
    scheduleGroupId: groupId,
    customer: {
      id: customerId,
      name: "PR736 Provider Proof",
      primaryPhone: PHONE,
    },
    pets: [
      {
        sourceId: sourcePetId,
        name: "Provider Proof Dog",
        species: "dog",
        breed: "Indie",
        vaccinationStatus: "verified",
      },
    ],
    cityId,
    zoneId,
    serviceCode: "grooming",
    packageCode: "dog-bath",
    packageName: "Essential Bath",
    scheduledStart,
    scheduledEnd,
    provider: {
      id: String(provider.id),
      name: String(provider.name),
      model: String(provider.model),
    },
    totalAmount: coupon?.finalAmount ?? 1349,
    amountDueNow: coupon?.finalAmount ?? 1349,
    payment: {
      method: "netbanking",
      mode: "prepaid",
      status: "created",
      detail: "PR736 exact Razorpay Test Mode provider proof; no live money",
    },
    pricing: coupon
      ? {
          discount: coupon.discount,
          couponCode: coupon.code,
          couponQuoteId: coupon.quoteId,
        }
      : { discount: 0 },
  });
  expect(
    booking.status,
    `Canonical booking failed: ${JSON.stringify(booking.body)}`,
  ).toBe(201);
  const bookingId = String(booking.body?.data?.bookingId || "");
  expect(bookingId).toMatch(/^PS-UAT-/);

  return { bookingId, petId, groupId, providerId: String(provider.id) };
}

async function createStrictTestCoupon(
  browser: import("@playwright/test").Browser,
  customerPage: Page,
  customerId: string,
) {
  expect(UAT_CODE.length).toBeGreaterThan(20);
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  const staff = await ctx.newPage();
  try {
    await staff.goto(`${ORIGIN}/staging-login`, {
      waitUntil: "domcontentloaded",
    });
    const login = await pagePost(staff, "/api/staging-login", {
      email: "founder@pawspace.in",
      code: UAT_CODE,
    });
    expect(
      login.status,
      `Founder UAT login failed: ${JSON.stringify(login.body)}`,
    ).toBe(200);
    const now = Date.now();
    const code = `UATPR736ONE${String(now).slice(-6)}`;
    const saved = await pagePost(staff, "/api/coupon-governance", {
      action: "save_campaign",
      campaign: {
        code,
        name: "PR736 strict one-rupee provider proof",
        status: "active",
        live: false,
        serviceCodes: ["grooming"],
        cityIds: ["blr"],
        channels: ["customer_app"],
        customerKinds: ["new", "existing", "subscriber"],
        packageScope: "selected",
        packageCodes: ["dog-bath"],
        crossSellFromServices: [],
        firstOrderOnly: false,
        minOrder: 1349,
        maxOrder: 1349,
        subscriptionEligible: false,
        fullPaymentOnly: true,
        discountType: "fixed",
        discountValue: 1348,
        maxDiscount: 1348,
        perCustomerLimit: 1,
        totalLimit: 1,
        validFrom: now - 60_000,
        validUntil: now + 60 * 60_000,
      },
    });
    expect(
      [200, 201],
      `TEST coupon campaign save failed: ${JSON.stringify(saved.body)}`,
    ).toContain(saved.status);
    expect(saved.body?.data?.testOnly).toBe(true);
    const quoted = await pagePost(customerPage, "/api/coupon-governance", {
      action: "quote",
      input: {
        code,
        customerId,
        serviceCode: "grooming",
        cityId: "blr",
        channel: "customer_app",
        packageCode: "dog-bath",
        orderValue: 1349,
        paymentMode: "full",
        isSubscription: false,
      },
    });
    expect(
      quoted.status,
      `TEST coupon quote failed: ${JSON.stringify(quoted.body)}`,
    ).toBe(200);
    expect(quoted.body?.data?.testOnly).toBe(true);
    expect(Number(quoted.body?.data?.discount)).toBe(1348);
    expect(Number(quoted.body?.data?.finalAmount)).toBe(1);
    return {
      quoteId: String(quoted.body.data.quoteId),
      code,
      discount: 1348,
      finalAmount: 1,
    };
  } finally {
    await ctx.close();
  }
}

async function strictFinancialTruth(dbId: string, bookingId: string) {
  const payment =
    (
      await d1(
        dbId,
        "SELECT id,customer_id,status,amount,amount_due_now,gateway FROM booking_payments WHERE booking_id=?",
        [bookingId],
      )
    )[0] || null;
  if (!payment)
    return {
      payment: null,
      reconciliation: null,
      postings: [] as Json[],
      journal: [] as Json[],
      lifecycleCount: 0,
    };
  const reconciliation =
    (
      await d1(
        dbId,
        "SELECT payment_id,booking_id,expected_amount,captured_amount,refunded_amount,gateway_status,reconciliation_status,variance_amount,last_event_id FROM payment_reconciliation_records WHERE payment_id=?",
        [payment.id],
      )
    )[0] || null;
  const postings = await d1(
    dbId,
    "SELECT group_key,event,payment_id,amount,verification_status FROM collection_ledger_postings WHERE payment_id=? AND event='online_payment_captured'",
    [payment.id],
  );
  const journal = await d1(
    dbId,
    "SELECT source_type,source_id,account_code,debit,credit,booking_id,customer_id,payment_id FROM finance_journal_entries WHERE source_type='online_payment_captured' AND source_id=? ORDER BY id",
    [payment.id],
  );
  const lifecycle = await d1(
    dbId,
    "SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='payment_captured'",
    [bookingId],
  );
  return {
    payment,
    reconciliation,
    postings,
    journal,
    lifecycleCount: Number(lifecycle[0]?.n || 0),
  };
}

async function visibleRazorpayFrame(page: Page) {
  await expect
    .poll(() => page.frames().some((frame) => /razorpay/i.test(frame.url())), {
      timeout: 25_000,
    })
    .toBeTruthy();
  return (
    page
      .frames()
      .find(
        (frame) => /razorpay/i.test(frame.url()) && frame !== page.mainFrame(),
      ) || page.frames().at(-1)!
  );
}

async function submitNetbankingSuccess(page: Page) {
  await visibleRazorpayFrame(page);
  const deadline = Date.now() + 60_000;
  let netbankingSelected = false;
  let bankSelected = false;
  while (Date.now() < deadline) {
    const frames = page
      .frames()
      .filter(
        (frame) => frame !== page.mainFrame() && /razorpay/i.test(frame.url()),
      );

    // Razorpay Checkout v2 can render the payment-method list before its mandatory
    // contact overlay is dismissed. Never click through that overlay: complete it,
    // verify that it is actually gone, then re-scan the checkout before proceeding.
    let contactOverlayWasVisible = false;
    for (const frame of frames) {
      try {
        const overlay = frame
          .locator('[data-testid="contact-overlay-container"]')
          .first();
        if (!(await overlay.isVisible().catch(() => false))) continue;
        contactOverlayWasVisible = true;
        const mobile = overlay
          .locator(
            '[data-testid="contactNumber"], input[name="contact"], input[placeholder="Mobile number"]',
          )
          .first();
        await mobile.waitFor({ state: "visible", timeout: 5_000 });
        await mobile.fill(PHONE);
        await expect
          .poll(() => mobile.inputValue().catch(() => ""), { timeout: 5_000 })
          .toBe(PHONE);
        const next = overlay
          .getByRole("button", { name: /^Continue$/i })
          .first();
        await next.waitFor({ state: "visible", timeout: 5_000 });
        await next.click({ timeout: 5_000 });
        await overlay.waitFor({ state: "hidden", timeout: 10_000 });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/Frame was detached|Execution context was destroyed|Target page, context or browser has been closed/i.test(
            message,
          )
        ) {
          // Checkout may briefly re-render the overlay after Continue. Keep the retry
          // bounded here instead of falling through and clicking a covered method.
          if (Date.now() + 1_000 >= deadline) throw error;
        }
      }
    }
    if (contactOverlayWasVisible) {
      await page.waitForTimeout(400);
      continue;
    }

    for (const frame of frames) {
      try {
        // A late/rerendered contact overlay is a hard blocker for payment-method clicks.
        const contactOverlay = frame
          .locator('[data-testid="contact-overlay-container"]')
          .first();
        if (await contactOverlay.isVisible().catch(() => false)) continue;

        if (!netbankingSelected) {
          const netbanking = frame
            .locator('[data-testid="netbanking"]')
            .first();
          if (await netbanking.isVisible().catch(() => false)) {
            await netbanking.click({ timeout: 5_000 });
            netbankingSelected = true;
            await page.waitForTimeout(700);
            continue;
          }
        }
        if (netbankingSelected && !bankSelected) {
          const search = frame
            .locator('input[placeholder*="bank" i],input[aria-label*="bank" i]')
            .first();
          if (await search.isVisible().catch(() => false))
            await search.fill("HDFC Bank");
          const bankChoices = [
            frame.getByRole("button", { name: /HDFC Bank/i }).first(),
            frame.locator('[data-value="HDFC"], [data-testid="HDFC"]').first(),
            frame.getByText(/^HDFC Bank$/i).first(),
            frame.getByText(/^HDFC$/i).first(),
          ];
          for (const choice of bankChoices) {
            if (!(await choice.isVisible().catch(() => false))) continue;
            const label = await choice.innerText().catch(() => "");
            if (
              /facing issues|unavailable|try with other payment options/i.test(
                label,
              )
            )
              continue;
            // Checkout v2 starts Netbanking processing when the bank itself is selected; there is no
            // separate generic "Pay" click to make. Retrying a hidden bank row can stall under the
            // processing overlay, so select one healthy Test bank once and wait for the mock bank UI.
            await choice.click({ timeout: 5_000 });
            bankSelected = true;
            await page.waitForTimeout(900);
            break;
          }
          if (bankSelected) continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/Frame was detached|Execution context was destroyed|Target page, context or browser has been closed/i.test(
            message,
          )
        )
          throw error;
      }
    }
    for (const candidatePage of page.context().pages()) {
      for (const surface of [candidatePage, ...candidatePage.frames()]) {
        try {
          const success = surface
            .getByRole("button", { name: /^Success$/i })
            .first();
          if (await success.isVisible().catch(() => false)) {
            await success.click({ timeout: 5_000 });
            return;
          }
        } catch {}
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    "Razorpay Test Netbanking mock-success control was not reached",
  );
}
async function paymentRows(dbId: string, bookingId: string) {
  return d1(
    dbId,
    "SELECT event_type,gateway_order_id,gateway_payment_id,signature_verified,processing_status,amount_subunits,currency FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at",
    [bookingId],
  );
}

async function paymentTruth(dbId: string, bookingId: string) {
  return (
    (
      await d1(
        dbId,
        "SELECT status,gateway,amount,amount_due_now FROM booking_payments WHERE booking_id=?",
        [bookingId],
      )
    )[0] || null
  );
}

async function intentTruth(dbId: string, bookingId: string) {
  return (
    (
      await d1(
        dbId,
        "SELECT state,gateway_order_id,gateway_payment_id,amount_paise,currency FROM payment_intents WHERE booking_id=? ORDER BY created_at DESC LIMIT 1",
        [bookingId],
      )
    )[0] || null
  );
}

async function waitForProviderPayment(
  orderId: string,
  wanted: (row: Json) => boolean,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let items: Json[] = [];
  while (Date.now() < deadline) {
    const provider = await rzp(`/v1/orders/${orderId}/payments`);
    items = Array.isArray(provider.items) ? provider.items : [];
    const hit = items.find(wanted);
    if (hit) return { hit, items };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { hit: null, items };
}

async function waitForProviderWebhook(
  dbId: string,
  bookingId: string,
  paymentId: string,
  timeoutMs = 75_000,
) {
  const deadline = Date.now() + timeoutMs;
  let rows: Json[] = [];
  while (Date.now() < deadline) {
    rows = await paymentRows(dbId, bookingId).catch(() => []);
    const hit = rows.find(
      (row) =>
        row.gateway_payment_id === paymentId &&
        Number(row.signature_verified) === 1 &&
        row.processing_status === "processed" &&
        ["payment.captured", "order.paid"].includes(String(row.event_type)),
    );
    if (hit) return { hit, rows };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { hit: null, rows };
}
test("PR736 product-native checkout proves Razorpay Test capture and provider-signed webhook via staging shadow relay", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  test.setTimeout(300_000);
  expect(CANDIDATE).toMatch(/^[0-9a-f]{40}$/);
  expect(ACCOUNT).toMatch(/^[a-f0-9]{32}$/i);
  expect(CF_TOKEN.length).toBeGreaterThan(20);
  expect(RZP_KEY).toMatch(/^rzp_test_[A-Za-z0-9]+$/);
  expect(RZP_SECRET.length).toBeGreaterThan(10);
  expect(GH_TOKEN.length).toBeGreaterThan(20);
  const { dbId, relay } = await revalidateTarget();
  const report: Json = {
    candidate: CANDIDATE,
    worker: WORKER,
    origin: ORIGIN,
    stagingDeploymentId: relay.stagingDeploymentId,
    amountPaise: PRECHECK_ONLY ? 0 : 100,
    liveMoney: false,
    refund: "NOT_RUN",
    syntheticWebhookReplay: false,
    providerWebhookPath: "razorpay_signed_via_staging_shadow_relay",
    providerCaptured: false,
    providerWebhookDelivery: false,
    bookingSetup: "product_api_only",
    directD1BookingMutation: false,
  };

  await page.goto(`${ORIGIN}/mobile-app`, { waitUntil: "domcontentloaded" });
  const otp = await pagePost(page, "/api/customer-otp", {
    action: "request",
    phone: PHONE,
  });
  expect(otp.status).toBe(200);
  expect(otp.body.data.sandboxDelivery).toBe(true);
  expect(otp.body.data.liveSmsDelivered).toBe(false);
  const verified = await pagePost(page, "/api/customer-otp", {
    action: "verify",
    challengeId: otp.body.data.challengeId,
    code: otp.body.data.sandboxCode,
    name: "PR736 Provider Proof",
    cityId: "blr",
    installId: `pr736-provider-${Date.now()}`,
  });
  expect(verified.status).toBe(200);
  const customerId = String(verified.body.data.customerId);
  const account = await page.evaluate(async () => {
    const response = await fetch("/api/customer-account", {
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  });
  expect(account.status).toBe(200);
  expect(account.body.data.customerId).toBe(customerId);
  const coupon = PRECHECK_ONLY
    ? undefined
    : await createStrictTestCoupon(browser, page, customerId);
  const fixture = await createProductNativePayableBooking(
    page,
    customerId,
    coupon,
  );
  report.bookingId = fixture.bookingId;
  report.productNativeSetup = true;
  report.catalogueGrossAmount = 1349;
  report.discount = coupon?.discount ?? 0;
  report.creditSetup = "none";
  const canonical =
    (
      await d1(
        dbId,
        "SELECT service_code,total_amount FROM canonical_bookings WHERE id=?",
        [fixture.bookingId],
      )
    )[0] || null;
  expect(canonical?.service_code).toBe("grooming");
  expect(Number(canonical?.total_amount)).toBe(PRECHECK_ONLY ? 1349 : 1);
  report.persistedBookingTotal = Number(canonical?.total_amount);
  const accountHistory = await page.evaluate(async () => {
    const r = await fetch("/api/customer-account", { cache: "no-store" });
    return { status: r.status, body: await r.json() };
  });
  expect(accountHistory.status).toBe(200);
  expect(
    accountHistory.body.data.bookings.some(
      (b: Json) =>
        b.id === fixture.bookingId &&
        Number(b.totalAmount) === (PRECHECK_ONLY ? 1349 : 1),
    ),
  ).toBe(true);
  report.customerHistoryBookingMatch = true;
  if (PRECHECK_ONLY) {
    report.precheckOnly = true;
    report.checkoutStarted = false;
    await testInfo.attach("pr736-product-native-precheck", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    console.log(`[PR736-PRECHECK] ${JSON.stringify(report)}`);
    return;
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  const accountTab = page
    .getByRole("navigation", { name: "Customer navigation" })
    .getByRole("button", { name: /Account$/i });
  await expect(accountTab).toBeVisible();
  await accountTab.click();
  const billing = page.locator("details").filter({
    has: page
      .locator("summary")
      .filter({ hasText: "Payments & invoice summaries" }),
  });
  await billing.locator("summary").click();
  const paymentRecord = billing
    .locator("article")
    .filter({ hasText: `Booking ${fixture.bookingId}` });
  await expect(
    paymentRecord,
    "The product-native booking must be the billing row we pay",
  ).toHaveCount(1);
  const pay = paymentRecord
    .getByRole("button", { name: /^(Review & pay|Check balance) \(test\)$/ })
    .first();
  await expect(pay).toBeVisible();
  const waitForStart = () =>
    page.waitForResponse((response) => {
      const request = response.request();
      return (
        new URL(response.url()).pathname === "/api/customer-checkout" &&
        request.method() === "POST" &&
        (request.postData() || "").includes('"action":"start"')
      );
    });
  await assertStagingRelayStable(relay);
  const firstWait = waitForStart();
  await pay.click();
  const first = await (await firstWait).json();
  expect(first.data.environment).toBe("sandbox");
  expect(first.data.amountPaise).toBe(100);
  expect(String(first.data.orderId)).toMatch(/^order_/);
  report.orderId = String(first.data.orderId);
  report.negativeCheckoutSemantics = "covered_by_exact_head_pr736_ci";
  await submitNetbankingSuccess(page);
  await expect(paymentRecord.getByRole("status")).toContainText(
    /pending|verified|confirmation/i,
    { timeout: 40_000 },
  );

  const provider = await waitForProviderPayment(
    report.orderId,
    (row) => row.status === "captured" || row.captured === true,
    50_000,
  );
  report.providerPaymentStatuses = provider.items.map((row) => ({
    id: row.id,
    status: row.status,
    captured: row.captured,
    amount: row.amount,
    currency: row.currency,
  }));
  if (provider.hit) {
    report.providerCaptured = true;
    report.providerPaymentId = provider.hit.id;
  }
  const delivered = provider.hit
    ? await waitForProviderWebhook(
        dbId,
        fixture.bookingId,
        String(provider.hit.id),
      )
    : {
        hit: null,
        rows: await paymentRows(dbId, fixture.bookingId).catch(() => []),
      };
  report.providerWebhookDelivery = Boolean(delivered.hit);
  await assertStagingRelayStable(relay);
  report.gatewayEvents = delivered.rows.map((row) => ({
    eventType: row.event_type,
    paymentId: row.gateway_payment_id,
    signatureVerified: Number(row.signature_verified) === 1,
    status: row.processing_status,
  }));
  const truth = await paymentTruth(dbId, fixture.bookingId);
  const intent = await intentTruth(dbId, fixture.bookingId);
  report.d1PaymentStatus = truth?.status;
  report.intentState = intent?.state;
  report.syntheticWebhookReplay = false;
  if (delivered.hit) {
    expect(truth?.status).toBe("captured");
    expect(intent?.state).toBe("CAPTURED");
    const finance = await strictFinancialTruth(dbId, fixture.bookingId);
    report.internalPaymentId = finance.payment?.id;
    report.reconciliation = finance.reconciliation;
    report.collectionPostings = finance.postings;
    report.collectionJournal = finance.journal;
    report.paymentCapturedTimelineCount = finance.lifecycleCount;
    expect(Number(finance.payment?.amount)).toBe(1);
    expect(Number(finance.payment?.amount_due_now)).toBe(1);
    expect(finance.reconciliation?.payment_id).toBe(finance.payment?.id);
    expect(finance.reconciliation?.booking_id).toBe(fixture.bookingId);
    expect(Number(finance.reconciliation?.expected_amount)).toBe(1);
    expect(Number(finance.reconciliation?.captured_amount)).toBe(1);
    expect(Number(finance.reconciliation?.refunded_amount || 0)).toBe(0);
    expect(Number(finance.reconciliation?.variance_amount || 0)).toBe(0);
    expect(String(finance.reconciliation?.reconciliation_status)).toBe(
      "matched",
    );
    expect(finance.postings).toHaveLength(1);
    expect(Number(finance.postings[0]?.amount)).toBe(1);
    expect(finance.journal).toHaveLength(2);
    const debit = finance.journal.reduce(
      (n: number, r: Json) => n + Number(r.debit || 0),
      0,
    );
    const credit = finance.journal.reduce(
      (n: number, r: Json) => n + Number(r.credit || 0),
      0,
    );
    report.ledgerDebit = debit;
    report.ledgerCredit = credit;
    report.reconciliationDelta = Math.round((debit - credit) * 100) / 100;
    expect(debit).toBe(1);
    expect(credit).toBe(1);
    expect(report.reconciliationDelta).toBe(0);
    expect(report.paymentCapturedTimelineCount).toBe(1);
    const signedCaptureEffects = delivered.rows.filter(
      (row) =>
        row.gateway_payment_id === String(provider.hit?.id || "") &&
        Number(row.signature_verified) === 1 &&
        row.processing_status === "processed" &&
        ["payment.captured", "order.paid"].includes(String(row.event_type)),
    );
    report.signedCaptureEffectEvents = signedCaptureEffects.length;
    expect(
      report.signedCaptureEffectEvents,
      "At least two signed capture-equivalent provider notifications are required to prove financial replay idempotency",
    ).toBeGreaterThanOrEqual(2);
    report.duplicateFinancialEffectPrevented =
      finance.postings.length === 1 &&
      finance.journal.length === 2 &&
      finance.lifecycleCount === 1;
    expect(report.duplicateFinancialEffectPrevented).toBe(true);
    const billing = await page.evaluate(async () => {
      const r = await fetch("/api/customer-billing", { cache: "no-store" });
      return { status: r.status, body: await r.json() };
    });
    expect(billing.status).toBe(200);
    expect(
      billing.body.data.payments.some(
        (p: Json) =>
          p.booking_id === fixture.bookingId &&
          p.id === String(finance.payment?.id || "") &&
          p.status === "captured" &&
          Number(p.amount) === 1,
      ),
    ).toBe(true);
    report.customerBillingIdentityMatch = true;
  }

  await testInfo.attach("pr736-product-native-provider-webhook-proof", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[PR736-PRODUCT-NATIVE-PROOF] ${JSON.stringify(report)}`);
  expect(
    report.providerCaptured,
    "A real Razorpay TEST payment must be captured; order creation alone is insufficient",
  ).toBe(true);
  expect(
    report.providerWebhookDelivery,
    "Razorpay-origin signed webhook delivery to this exact isolated Worker is still required; no synthetic replay is allowed",
  ).toBe(true);
  expect(report.d1PaymentStatus).toBe("captured");
  expect(report.intentState).toBe("CAPTURED");
  expect(report.customerHistoryBookingMatch).toBe(true);
  expect(report.customerBillingIdentityMatch).toBe(true);
  expect(report.reconciliationDelta).toBe(0);
  expect(report.duplicateFinancialEffectPrevented).toBe(true);
});
