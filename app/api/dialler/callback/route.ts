import { database } from "../../../../lib/server-auth";
import { applyEmployeePowerDiallerCallback } from "../../../../lib/employee-power-dialler";

async function runtimeEnv() {
  try { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }
  catch { return {}; }
}

export async function POST(request: Request) {
  try {
    const db = await database();
    const rawBody = await request.text();
    const data = await applyEmployeePowerDiallerCallback(db, await runtimeEnv(), { rawBody, headers: request.headers });
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const authFailure = message.includes("callback authentication failed");
    console.error("[employee-power-dialler] callback rejected", authFailure ? "authentication_failed" : "invalid_callback");
    return Response.json({ error: authFailure ? "Callback authentication failed" : "Unable to process dialler callback" }, { status: authFailure ? 401 : 400, headers: { "cache-control": "no-store" } });
  }
}
