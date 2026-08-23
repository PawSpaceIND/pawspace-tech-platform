import{authError}from"../../../lib/server-auth";
import { resolveLivePrice } from "../../../lib/live-pricing-resolver";

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

/**
 * Public, unauthenticated by design (matches /api/pricing-quote's existing pattern for
 * customer-facing price checks). The customer app keeps its own local catalogue as the source of
 * truth for which packages exist and their default price - this endpoint is called on top of that,
 * passing the app's own computed fallback price, and only overrides it if ops has genuinely
 * published a live price for this exact package in the Pricing Control panel. If nothing has been
 * configured, the app's own fallback comes back unchanged - so this call is always safe to make,
 * even for packages nobody has ever touched in the panel.
 */
export async function POST(request: Request) {
  try {
    const db = await database();
    const body = (await request.json()) as {
      packageCode?: string; fallbackPrice?: number; scheduledStart?: string; cityId?: string; zoneId?: string; quantity?: number;
    };
    if (!body.packageCode || !Number.isFinite(body.fallbackPrice) || !body.scheduledStart || !body.cityId) {
      return Response.json({ error: "packageCode, fallbackPrice, scheduledStart and cityId are required" }, { status: 400 });
    }
    const result = await resolveLivePrice(db, {
      packageCode: body.packageCode,
      fallbackPrice: Number(body.fallbackPrice),
      scheduledStart: body.scheduledStart,
      cityId: body.cityId,
      zoneId: body.zoneId,
      quantity: body.quantity,
    });
    return Response.json({ data: result });
  } catch (error) {
    return authError(error,"Live price check failed");
  }
}
