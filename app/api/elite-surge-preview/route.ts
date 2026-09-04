import { authError, authorize } from "../../../lib/server-auth";
import { calculateEliteSurgePreview } from "../../../lib/services/elite-runtime";
import type { SurgePricingInput } from "../../../lib/policies/surge-pricing-engine";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  try {
    await authorize(request, "pricing.manage");
    const body = await request.json() as Partial<SurgePricingInput>;
    if (!body.service || !body.zone || !body.weather || !body.capacity || !Number.isFinite(body.basePricePaise)) {
      return json({ error: "service, basePricePaise, zone, weather and capacity are required" }, 400);
    }
    const quote = calculateEliteSurgePreview(body as SurgePricingInput);
    return json({ data: quote, mode: "preview_only", customerPriceMutation: false });
  } catch (error) {
    return authError(error, "Unable to calculate Elite surge preview");
  }
}
