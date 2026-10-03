import { governedJsonError } from "../../../../lib/governed-http-error";
import { env } from "cloudflare:workers";
import { authError, authFailure, database, requireCustomerOwnership, resolveActor } from "../../../../lib/server-auth";
import { resolvePlatformSession } from "../../../../lib/platform-session";
import { redeemTestCoins, syncTestCoins, testCoinBookingPreview, testCoinHistory } from "../../../../lib/v2/test-coin-ledger";
import { coinSourceQuery, coinSources, validCoinSource } from "../../../../lib/v2/test-coin-sources";
import { requireTestCoinPolicy, testCoinPolicy } from "../../../../lib/v2/test-coin-policy";
const json = (data: unknown) => Response.json({ data }, { headers: { "cache-control": "no-store" } });
async function context(request: Request) {
  const policy = testCoinPolicy(env as unknown as Record<string, unknown>);
  requireTestCoinPolicy(policy);
  const db = await database(), actor = await resolveActor(request), session = await resolvePlatformSession(db, request);
  const customerId = session?.subjectType === "customer" ? session.subjectId : "";
  if (!customerId) throw authFailure("Sign in as a customer to use TEST coins", 401);
  await requireCustomerOwnership(db, actor, customerId);
  return { db, customerId, policy };
}
async function services(db: D1Database, customerId: string) {
  const result: { source: string; id: string; serviceCode: string; status: string }[] = [];
  for (const source of coinSources) {
    const query = await coinSourceQuery(db, source);
    if (!query.available) continue;
    const rows = await db.prepare(`SELECT id,service_code,status FROM (${query.sql}) WHERE customer_id=? ORDER BY id DESC LIMIT 50`).bind(customerId).all<Record<string, unknown>>();
    result.push(...rows.results.map(r => ({ source, id: String(r.id), serviceCode: String(r.service_code), status: String(r.status) })));
  }
  return result;
}
export async function GET(request: Request) {
  try {
    const { db, customerId, policy } = await context(request);
    const url = new URL(request.url), id = url.searchParams.get("id"), source = url.searchParams.get("source");
    if (id) {
      if (!validCoinSource(source)) throw governedJsonError({ error: "Unknown service" }, 400);
      return json(await testCoinBookingPreview(db, customerId, source, id, policy));
    }
    return json(await testCoinHistory(db, customerId, policy, url.searchParams.get("historyCursor") || undefined));
  } catch (error) { return authError(error, "Unable to load TEST coins"); }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw governedJsonError({ error: "Cross-origin TEST coin request blocked" }, 403);
    const { db, customerId, policy } = await context(request);
    const body = await request.json() as { action?: string; source?: string; id?: string; coins?: number };
    if (body.action === "sync") return json({ ...(await syncTestCoins(db, customerId, policy, customerId)), services: await services(db, customerId) });
    if (body.action !== "redeem" || !validCoinSource(body.source) || typeof body.id !== "string" || !body.id.trim())
      throw governedJsonError({ error: "Choose a service booking and TEST redemption" }, 400);
    return json(await redeemTestCoins(db, { customerId, actorId: customerId, source: body.source, id: body.id, coins: body.coins as number }, policy));
  } catch (error) { return authError(error, "Unable to update TEST coins"); }
}
