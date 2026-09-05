import { database } from "../../../../lib/server-auth";
import { applyDiallerCallback, ensureEmployeeDiallerTables } from "../../../../lib/employee-power-dialler";

async function runtimeEnv() {
  try { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }
  catch { return {}; }
}

export async function POST(request: Request) {
  try {
    const db = await database(); await ensureEmployeeDiallerTables(db);
    const rawBody = await request.text();
    const result = await applyDiallerCallback(db, await runtimeEnv(), { rawBody, headers: request.headers });
    return Response.json(result);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status || 500) : 500;
    console.error("[employee-dialler-callback] callback rejected", error);
    return Response.json({ error: status === 401 ? "Callback authentication failed" : "Unable to process dialler callback" }, { status, headers: { "cache-control": "no-store" } });
  }
}
