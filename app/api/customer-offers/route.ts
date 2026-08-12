// Public, unauthenticated endpoint - a customer needs to see which coupon codes are available
// (and whether one auto-applies) before or during checkout, same posture as /api/customer-otp and
// /api/host-profile. Real discount eligibility is still only ever decided by the existing
// quoteCoupon()/consumeCouponQuote() flow behind /api/coupon-governance - this route only lists.
import { listAvailableCoupons } from "../../../lib/customer-offers";

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

export async function GET(request: Request) {
  try {
    const customerId = new URL(request.url).searchParams.get("customerId");
    if (!customerId) return Response.json({ error: "customerId is required" }, { status: 400 });
    const db = await database();
    const offers = await listAvailableCoupons(db, { customerId });
    return Response.json({ data: offers }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load offers" }, { status: 500 });
  }
}
