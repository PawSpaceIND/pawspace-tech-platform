import {expect,test} from "@playwright/test";

test("customer confirmation polls until the owned canonical projection is complete",async({page})=>{
  let reads=0,ready=false;
  await page.route("**/api/customer-checkout",async route=>{
    const body=route.request().postDataJSON() as{action?:string;bookingId?:string};
    expect(body.action).toBe("status");expect(body.bookingId).toBe("BK-HYDRATE-1");
    reads+=1;if(reads===1)setTimeout(()=>{ready=true},3_000);
    await route.fulfill({json:{data:{bookingId:"BK-HYDRATE-1",environment:"sandbox",status:"captured",confirmation:{
      ready,bookingId:"BK-HYDRATE-1",serviceCode:"grooming",packageName:"Bath & Full Groom",bookingStatus:"confirmed",
      paymentId:"PAY-HYDRATE-1",paymentMode:"prepaid",paymentStatus:"captured",transactionId:ready?"pay_CanonicalTruth1":null,amountDueNow:0,
      totalAmount:1499,currency:"INR",providerId:"PRV-RAHUL",providerName:"Rahul M.",providerModel:"full_time",workOrderStatus:"assigned",
      scheduledStart:"2026-09-20T03:30:00.000Z",scheduledEnd:"2026-09-20T05:30:00.000Z",updatedAt:Date.now(),
    }}}});
  });
  await page.goto("/mobile-app/booking-confirmation?bookingId=BK-HYDRATE-1");
  await expect(page.getByRole("region",{name:"Confirmation synchronizing"})).toBeVisible();
  await expect(page.getByRole("region",{name:"Payment verified"})).toBeVisible({timeout:12_000});
  const details=page.getByRole("region",{name:"Booking details"});
  await expect(details).toContainText("Rahul M. · full time");
  await expect(details).toContainText("pay_CanonicalTruth1");
  await expect(details).toContainText(/20 Sept 2026, 9:00 am.*20 Sept 2026, 11:00 am/);
  expect(reads).toBeGreaterThanOrEqual(3);
});

test("Founder activity shows a future service updated today without changing today's schedule metrics",async({page})=>{
  await page.route("**/api/operations-overview*",route=>route.fulfill({json:{data:{
    date:"2026-09-13",dayWindow:{timezone:"Asia/Kolkata",startUtc:"2026-09-12T18:30:00.000Z",endUtc:"2026-09-13T18:30:00.000Z"},zoneId:null,zones:["blr-east"],
    metrics:{bookingsToday:0,confirmed:0,completed:0,inProgress:0,cancelled:0,unassigned:0,recognizedRevenue:0,providersActive:0,providersTotal:0,openTickets:0,ticketsNeedingAttention:0},
    capacity:[],capacityShown:0,capacityTotal:0,slots:["9–11","11–1","1–3","3–5","5–7"],
    activity:[{bookingId:"BK-FUTURE-TODAY",customer:"Canonical Customer",service:"grooming",packageName:"Bath & Full Groom",status:"confirmed",provider:"Rahul M.",scheduledStart:"2026-09-20T03:30:00.000Z",scheduledTimeIst:"09:00",activityAt:Date.now(),slot:"9–11",amount:1499}],
    activityShown:1,activityTotal:1,sourceStatus:{bookings:"canonical_bookings"},
  }}}));
  await page.goto("/admin");
  await expect(page.getByText("BK-FUTURE-TODAY",{exact:true}).first()).toBeVisible();
  await expect(page.getByText("Today’s bookings",{exact:true}).locator("..")).toContainText("0");
  await expect(page.getByText("Service slot (Asia/Kolkata)",{exact:true}).locator("..")).toContainText("Sunday 20 September 2026");
});
