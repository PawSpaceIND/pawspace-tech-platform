import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { listWhatsAppTemplateLifecycle, pauseWhatsAppTemplate, reconcileWhatsAppTemplate, saveWhatsAppTemplateDraft, submitWhatsAppTemplate } from "../../../../lib/whatsapp-template-lifecycle";

type Body = {
  action?: string;
  templateKey?: string;
  displayName?: string;
  category?: string;
  language?: string;
  body?: string;
  sampleValues?: unknown[];
  reason?: string;
  outcome?: "approved" | "rejected";
  metaReference?: string;
};

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin WhatsApp template write blocked", { status: 403 });
}

export async function GET(request: Request) {
  try {
    await authorize(request, "communications.manage");
    const db = await database();
    return json({ data: await listWhatsAppTemplateLifecycle(db) });
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to load WhatsApp templates");
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await authorize(request, "communications.manage");
    const db = await database();
    const body = await request.json() as Body;
    const action = String(body.action || "").trim();
    const templateKey = String(body.templateKey || "").trim();

    if (action === "save_draft") {
      const data = await saveWhatsAppTemplateDraft(db, {
        templateKey,
        displayName: String(body.displayName || ""),
        category: String(body.category || ""),
        language: String(body.language || ""),
        body: String(body.body || ""),
        sampleValues: body.sampleValues,
        actorEmail: actor.email,
      });
      await securityAudit(db, actor, "whatsapp.template.draft_saved", "whatsapp_template", templateKey, "completed", { category: body.category, language: body.language, productionDelivery: false, externalMetaMutation: false });
      return json({ data }, 201);
    }

    if (action === "submit") {
      const data = await submitWhatsAppTemplate(db, { templateKey, actorEmail: actor.email, reason: String(body.reason || "") });
      await securityAudit(db, actor, "whatsapp.template.submitted", "whatsapp_template", templateKey, "completed", { productionDelivery: false, externalMetaMutation: false });
      return json({ data });
    }

    if (action === "reconcile") {
      const outcome = body.outcome;
      if (outcome !== "approved" && outcome !== "rejected") return json({ error: "Outcome must be approved or rejected" }, 400);
      const data = await reconcileWhatsAppTemplate(db, { templateKey, actorEmail: actor.email, outcome, metaReference: String(body.metaReference || ""), reason: String(body.reason || "") });
      await securityAudit(db, actor, `whatsapp.template.${outcome}`, "whatsapp_template", templateKey, "completed", { metaReference: body.metaReference, productionDelivery: false, externalMetaMutation: false });
      return json({ data });
    }

    if (action === "pause") {
      const data = await pauseWhatsAppTemplate(db, { templateKey, actorEmail: actor.email, reason: String(body.reason || "") });
      await securityAudit(db, actor, "whatsapp.template.paused", "whatsapp_template", templateKey, "completed", { productionDelivery: false });
      return json({ data });
    }

    return json({ error: "Supported actions are save_draft, submit, reconcile or pause" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to update WhatsApp template lifecycle");
  }
}
