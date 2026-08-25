import{authError}from"../../../lib/server-auth";
// Public, unauthenticated endpoint - a customer views a host/sitter's rich profile before booking,
// pre-login. Demo/UAT profile data, when needed, must be provisioned by controlled UAT setup rather
// than mutated into the database by a public GET request.
import { getHostProfile } from "../../../lib/host-profiles";

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

export async function GET(request: Request) {
  try {
    const providerId = new URL(request.url).searchParams.get("providerId");
    if (!providerId) return Response.json({ error: "providerId is required" }, { status: 400 });
    const db = await database();
    const profile = await getHostProfile(db, providerId);
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ data: profile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authError(error,"Unable to load host profile");
  }
}
