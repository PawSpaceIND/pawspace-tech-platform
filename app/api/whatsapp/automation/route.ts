import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { listWhatsAppNoResponseAutomation, processDueWhatsAppNoResponseSequences, saveWhatsAppNoResponseConfig } from "../../../../lib/whatsapp-no-response-sequence";

type Body = { action?: string; enabled?: boolean; templateKeys?: string[]; offerType?: string; offerReference?: string; limit?: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin WhatsApp automation write blocked", { status: 403 }); }

export async function GET(request: Request) {
  try {
    await authorize(request, "communications.manage");
    const db = await database();
    return json({ data: await listWhatsAppNoResponseAutomation(db) });
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to load WhatsApp automation");
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await authorize(request, "communications.manage");
    const db = await database();
    const body = await request.json() as Body;
    const action = String(body.action || "").trim();
    if (action === "save_no_response") {
      const data = await saveWhatsAppNoResponseConfig(db, { enabled: body.enabled === true, templateKeys: Array.isArray(body.templateKeys) ? body.templateKeys : [], offerType: String(body.offerType || ""), offerReference: String(body.offerReference || ""), actorEmail: actor.email });
      await securityAudit(db, actor, "whatsapp.automation.no_response_saved", "whatsapp_automation", "no_response", "completed", { delaysMinutes: [10, 30, 180], offerType: body.offerType, offerReferenceConfigured: Boolean(String(body.offerReference || "").trim()), productionDelivery: false });
      return json({ data });
    }
    if (action === "process_due_uat") {
      const data = await processDueWhatsAppNoResponseSequences(db, { actorEmail: actor.email, limit: body.limit });
      await securityAudit(db, actor, "whatsapp.automation.no_response_sweep", "whatsapp_automation", "no_response", "completed", { processed: data.processed, queued: data.queued, blocked: data.blocked, productionDelivery: false });
      return json({ data });
    }
    return json({ error: "Supported actions are save_no_response or process_due_uat" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to update WhatsApp automation");
  }
}
