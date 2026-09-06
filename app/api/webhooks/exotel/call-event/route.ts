import { authError, database } from "../../../../../lib/server-auth";
import { recordVoiceBridgeEvent } from "../../../../../lib/voice-bridge-governance";
import { readBoundedRequestText, VoiceFetchRefused } from "../../../../../lib/voice-safe-fetch";

const MAX_CALLBACK_BYTES = 65_536;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  try {
    let raw: string;
    try { raw = await readBoundedRequestText(request, MAX_CALLBACK_BYTES); }
    catch (error) { if (error instanceof VoiceFetchRefused) return json({ error: "Exotel callback payload is too large" }, 413); throw error; }
    const db = await database();
    const { env } = await import("cloudflare:workers");
    const result = await recordVoiceBridgeEvent(db, env as unknown as Record<string, unknown>, { rawBody: raw, headers: request.headers });
    if (!result.accepted) return json({ error: result.reason }, result.status);
    return json({ ok: true, ...result }, result.status);
  } catch (error) {
    return authError(error, "Unable to process Exotel masked-call event");
  }
}
