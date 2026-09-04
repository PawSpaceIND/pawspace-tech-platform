import { authError, authorize, database } from "../../../lib/server-auth";
import { eliteRuntimeStatus } from "../../../lib/services/elite-runtime";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    await authorize(request, "reports.view");
    const db = await database();
    return json({ data: await eliteRuntimeStatus(db) });
  } catch (error) {
    return authError(error, "Unable to load Elite runtime health");
  }
}
