// Public, unauthenticated endpoint - a customer needs to see who they've been matched with before
// they've logged in or booked anything. Deliberately returns only the safe fields assembled by
// getProviderPublicProfile - no internal IDs, no address, no phone, no rating/quality_score.
import{redactUnexpected}from"../../../lib/governed-http-error";
import { getProviderPublicProfile } from "../../../lib/provider-public-profile";

async function getDatabase() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

export async function GET(request: Request) {
  try {
    const providerId = new URL(request.url).searchParams.get("providerId");
    if (!providerId) return Response.json({ error: "providerId is required" }, { status: 400 });
    const db = await getDatabase();
    const profile = await getProviderPublicProfile(db, providerId);
    if (!profile) return Response.json({ error: "Provider not found" }, { status: 404 });
    return Response.json({ data: profile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: redactUnexpected(error,"Unable to load provider profile") }, { status: 500 });
  }
}
