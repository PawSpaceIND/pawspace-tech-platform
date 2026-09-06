import{authError}from"../../../lib/server-auth";
import{uatLoginEnabled}from"../../../lib/uat-staging-auth";
// Public, unauthenticated endpoint - a customer views a host/sitter's rich profile before booking,
// pre-login. Demo/UAT profile data only (see lib/host-profiles.ts for why this is deliberately
// separate from lib/provider-public-profile.ts).
import { getHostProfile, seedDemoHostProfiles } from "../../../lib/host-profiles";

type HostProfileEnv={DB:D1Database;PAWSPACE_UAT_LOGIN?:unknown;PAWSPACE_UAT_SIGNING_KEY?:unknown};
async function runtime():Promise<HostProfileEnv> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as HostProfileEnv;
}

export async function GET(request: Request) {
  try {
    const providerId = new URL(request.url).searchParams.get("providerId");
    if (!providerId) return Response.json({ error: "providerId is required" }, { status: 400 });
    const env = await runtime(),db=env.DB;
    // Demo profile rows belong only to the explicitly configured isolated UAT worker. A public GET in
    // any other environment is read-only and may return 404; it must never manufacture demo providers.
    if (uatLoginEnabled(env)) await seedDemoHostProfiles(db);
    const profile = await getHostProfile(db, providerId);
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json({ data: profile }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authError(error,"Unable to load host profile");
  }
}
