// Public, unauthenticated endpoint - a customer views a host/sitter's rich profile before booking,
// pre-login. Demo/UAT profile data only (see lib/host-profiles.ts for why this is deliberately
// separate from lib/provider-public-profile.ts).
import { getHostProfile, seedDemoHostProfiles } from "../../../lib/host-profiles";

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

// D6: seeding the synthetic demo host/sitter profiles is a staging/UAT convenience only. It is gated
// on PAWSPACE_UAT_LOGIN==="on" — the established staging flag (see lib/uat-staging-auth.ts and the
// finance-control seed() convention). In production the flag is unset, so this public endpoint NEVER
// inserts synthetic profile rows. The read itself stays public and getHostProfile still ensures the
// schema, so a real/empty D1 keeps working; only the demo-data side effect is gated off.
async function seedEnabled() {
  const { env } = await import("cloudflare:workers");
  return String((env as Record<string, unknown>).PAWSPACE_UAT_LOGIN || "") === "on";
}

export async function GET(request: Request) {
  try {
    const providerId = new URL(request.url).searchParams.get("providerId");
    if (!providerId) return Response.json({ error: "providerId is required" }, { status: 400 });
    const db = await database();
    if (await seedEnabled()) await seedDemoHostProfiles(db);
    const profile = await getHostProfile(db, providerId);
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ data: profile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load host profile" }, { status: 500 });
  }
}
