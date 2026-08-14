// Public, unauthenticated endpoint - a customer views a host/sitter's rich profile before booking,
// pre-login. Demo/UAT profile data only (see lib/host-profiles.ts for why this is deliberately
// separate from lib/provider-public-profile.ts).
import { getHostProfile, seedDemoHostProfiles } from "../../../lib/host-profiles";

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

export async function GET(request: Request) {
  try {
    const providerId = new URL(request.url).searchParams.get("providerId");
    if (!providerId) return Response.json({ error: "providerId is required" }, { status: 400 });
    const db = await database();
    // Finding D6: demo/synthetic host seeding must never run on a production read. Gate it behind the
    // explicit staging flag (fail-closed: PAWSPACE_UAT_LOGIN unset in production → no seed).
    const { env } = await import("cloudflare:workers");
    if (String((env as Record<string, unknown>).PAWSPACE_UAT_LOGIN || "") === "on") await seedDemoHostProfiles(db);
    const profile = await getHostProfile(db, providerId);
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ data: profile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load host profile" }, { status: 500 });
  }
}
