import { database } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import { appearanceCookie } from "../../components/appearance-resolver";
import { appearanceCookieValue, mutateAccountAppearance, readAccountAppearance } from "../../../lib/appearance-preferences";

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
function failure(error: unknown) { return error instanceof Response ? error : json({ error: "Account appearance unavailable" }, 503); }
async function context(request: Request) {
  const db = await database(), session = await resolvePlatformSession(db, request);
  if (!session) throw json({ error: "Verified identity session required" }, 401);
  return { db, session, options: { cookieValue: appearanceCookieValue(request) } };
}
export async function GET(request: Request) {
  try {
    const { db, session, options } = await context(request);
    if ([...new URL(request.url).searchParams].length) return json({ error: "Appearance subject comes from the session" }, 400);
    return json({ data: await readAccountAppearance(db, session, options) });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-origin appearance write blocked" }, 403);
    const { db, session, options } = await context(request);
    const body: unknown = await request.json().catch(() => null);
    const result = await mutateAccountAppearance(db, session, body, options);
    return json(result, 200, { "set-cookie": appearanceCookie(result.data.record, new URL(request.url).protocol === "https:") });
  } catch (error) { return failure(error); }
}
