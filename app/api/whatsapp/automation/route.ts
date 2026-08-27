import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { actorCanAccessConversation } from "../../../../lib/conversation-access";
import { evaluateWhatsAppAutomationRule, listWhatsAppAutomationRules, saveWhatsAppAutomationRule, type WhatsAppAutomationRule, type WhatsAppAutomationTrigger } from "../../../../lib/whatsapp-automation-rules";
import { listWhatsAppNoResponseAutomation, processDueWhatsAppNoResponseSequences, saveWhatsAppNoResponseConfig } from "../../../../lib/whatsapp-no-response-sequence";

type Body = { action?: string; enabled?: boolean; templateKeys?: string[]; offerType?: string; offerReference?: string; quietHoursStart?: string; quietHoursEnd?: string; quietHoursTimezone?: string; maxMarketingMessagesPer24h?: number; limit?: number; rule?: WhatsAppAutomationRule; ruleId?: string; threadId?: string; eventId?: string; trigger?: WhatsAppAutomationTrigger; messageText?: string; messageClass?: "template" | "non_template"; now?: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin WhatsApp automation write blocked", { status: 403 }); }

export async function GET(request: Request) {
  try {
    await authorize(request, "communications.manage");
    const db = await database();
    const [recovery, rules] = await Promise.all([listWhatsAppNoResponseAutomation(db), listWhatsAppAutomationRules(db)]);
    return json({ data: { ...recovery, rules: rules.rules, ruleExecutionBoundary: "governed UAT evaluation only; external mutation disabled" } });
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
      const data = await saveWhatsAppNoResponseConfig(db, {
        enabled: body.enabled === true,
        templateKeys: Array.isArray(body.templateKeys) ? body.templateKeys : [],
        offerType: String(body.offerType || ""),
        offerReference: String(body.offerReference || ""),
        quietHoursStart: String(body.quietHoursStart || ""),
        quietHoursEnd: String(body.quietHoursEnd || ""),
        quietHoursTimezone: String(body.quietHoursTimezone || ""),
        maxMarketingMessagesPer24h: Number(body.maxMarketingMessagesPer24h || 0),
        actorEmail: actor.email,
      });
      await securityAudit(db, actor, "whatsapp.automation.no_response_saved", "whatsapp_automation", "no_response", "completed", {
        delaysMinutes: [10, 30, 180], offerType: body.offerType, offerReferenceConfigured: Boolean(String(body.offerReference || "").trim()), quietHoursConfigured: Boolean(String(body.quietHoursStart || "").trim() && String(body.quietHoursEnd || "").trim() && String(body.quietHoursTimezone || "").trim()), maxMarketingMessagesPer24h: Number(body.maxMarketingMessagesPer24h || 0), productionDelivery: false,
      });
      return json({ data });
    }
    if (action === "process_due_uat") {
      const data = await processDueWhatsAppNoResponseSequences(db, { actorEmail: actor.email, limit: body.limit });
      await securityAudit(db, actor, "whatsapp.automation.no_response_sweep", "whatsapp_automation", "no_response", "completed", { processed: data.processed, queued: data.queued, blocked: data.blocked, deferred: data.deferred, productionDelivery: false });
      return json({ data });
    }
    if (action === "save_rule_contract") {
      if (!body.rule) return json({ error: "Rule contract is required" }, 400);
      const data = await saveWhatsAppAutomationRule(db, body.rule, actor.email);
      await securityAudit(db, actor, "whatsapp.automation.rule_saved", "whatsapp_automation", body.rule.id, "completed", { trigger: body.rule.trigger, externalMutation: false, productionDelivery: false });
      return json({ data });
    }
    if (action === "evaluate_rule_uat") {
      const threadId = String(body.threadId || "").trim();
      if (!threadId) return json({ error: "Canonical conversation thread is required" }, 400);
      if (!(await actorCanAccessConversation(db, actor, threadId))) {
        await securityAudit(db, actor, "whatsapp.automation.rule_evaluated", "conversation", threadId, "denied", { reason: "row_scope", externalMutation: false, productionDelivery: false });
        return json({ error: "Conversation access denied" }, 403);
      }
      const data = await evaluateWhatsAppAutomationRule(db, { ruleId: String(body.ruleId || ""), threadId, eventId: String(body.eventId || ""), trigger: body.trigger as WhatsAppAutomationTrigger, messageText: body.messageText, messageClass: body.messageClass, now: body.now, actorEmail: actor.email });
      await securityAudit(db, actor, "whatsapp.automation.rule_evaluated", "whatsapp_automation", String(body.ruleId || ""), "completed", { matched: data.matched, actionCount: data.plan.length, threadId, externalMutation: false, productionDelivery: false });
      return json({ data });
    }
    return json({ error: "Supported actions are save_no_response, process_due_uat, save_rule_contract or evaluate_rule_uat" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to update WhatsApp automation");
  }
}
