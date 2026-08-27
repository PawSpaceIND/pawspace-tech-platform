type Db = D1Database;
type Row = Record<string, unknown>;

export type WhatsAppAutomationTrigger = "conversation_started" | "inbound_message" | "working_hours_open" | "working_hours_closed" | "customer_no_response";
export type WhatsAppAutomationMessageClass = "any" | "template" | "non_template";
export type WhatsAppAutomationAction =
  | { type: "send_welcome"; text: string }
  | { type: "send_ooo"; text: string }
  | { type: "start_chatbot"; entryPoint: "default" | "keyword" }
  | { type: "schedule_no_response"; profile: "10m_30m_3h" }
  | { type: "route"; strategy: "last_assignee" | "team" | "round_robin"; teamCode?: string }
  | { type: "webhook"; targetKey: string; authMode: "hmac_sha256" }
  | { type: "tool"; toolKey: string; authMode: "service_token" };

export type WhatsAppAutomationRule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: WhatsAppAutomationTrigger;
  filters?: {
    messageClass?: WhatsAppAutomationMessageClass;
    keywords?: string[];
    defaultAction?: boolean;
    workingHours?: { start: string; end: string; timeZone: string };
  };
  actions: WhatsAppAutomationAction[];
};

const triggers = new Set<WhatsAppAutomationTrigger>(["conversation_started", "inbound_message", "working_hours_open", "working_hours_closed", "customer_no_response"]);
const allowedWebhookTargets = new Set(["crm_event", "booking_event", "case_event"]);
const allowedTools = new Set(["lead_update", "booking_lookup", "booking_quote"]);
const stableKey = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const text = (value: unknown) => String(value ?? "").trim();
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } };
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

function validTimezone(value: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); return true; } catch { return false; } }
function clockMinute(value: string) { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function inWorkingHours(now: number, schedule: { start: string; end: string; timeZone: string }) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const current = Number(parts.find((part) => part.type === "hour")?.value || 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value || 0);
  const start = clockMinute(schedule.start), end = clockMinute(schedule.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function normalizedAction(action: WhatsAppAutomationAction): WhatsAppAutomationAction {
  if (action.type === "send_welcome" || action.type === "send_ooo") {
    const body = text(action.text);
    if (!body || body.length > 1024) throw new Response("Automation message text must be 1 to 1024 characters", { status: 400 });
    return { ...action, text: body };
  }
  if (action.type === "schedule_no_response") {
    if (action.profile !== "10m_30m_3h") throw new Response("Only the certified 10m_30m_3h no-response profile is allowed", { status: 409 });
    return action;
  }
  if (action.type === "route") {
    if (!(["last_assignee", "team", "round_robin"] as const).includes(action.strategy)) throw new Response("Unsupported WhatsApp routing strategy", { status: 400 });
    if ((action.strategy === "team" || action.strategy === "round_robin") && !stableKey.test(text(action.teamCode).toLowerCase())) throw new Response("Team and round-robin routing require a canonical team code", { status: 400 });
    return { ...action, teamCode: action.teamCode ? text(action.teamCode).toLowerCase() : undefined };
  }
  if (action.type === "webhook") {
    if (!allowedWebhookTargets.has(text(action.targetKey)) || action.authMode !== "hmac_sha256") throw new Response("Webhook action must use an allow-listed target with HMAC authentication", { status: 409 });
    return { ...action, targetKey: text(action.targetKey) };
  }
  if (action.type === "tool") {
    if (!allowedTools.has(text(action.toolKey)) || action.authMode !== "service_token") throw new Response("Tool action must use an allow-listed internal tool with service authentication", { status: 409 });
    return { ...action, toolKey: text(action.toolKey) };
  }
  if (action.type === "start_chatbot") {
    if (action.entryPoint !== "default" && action.entryPoint !== "keyword") throw new Response("Chatbot rule entry point must be default or keyword", { status: 400 });
    return action;
  }
  throw new Response("Unsupported WhatsApp automation action", { status: 400 });
}

export function buildWhatsAppAutomationRuleContract(input: WhatsAppAutomationRule): WhatsAppAutomationRule {
  const id = text(input.id).toLowerCase(), name = text(input.name);
  if (!stableKey.test(id) || name.length < 3 || name.length > 120) throw new Response("Stable rule id and name are required", { status: 400 });
  if (!triggers.has(input.trigger)) throw new Response("Unsupported WhatsApp automation trigger", { status: 400 });
  const keywords = [...new Set((input.filters?.keywords || []).map((value) => text(value).toLowerCase()).filter(Boolean))];
  if (keywords.some((value) => value.length > 80)) throw new Response("Automation keywords must be at most 80 characters", { status: 400 });
  const messageClass = input.filters?.messageClass || "any";
  if (!(new Set(["any", "template", "non_template"])).has(messageClass)) throw new Response("Unsupported no-response message class", { status: 400 });
  const schedule = input.filters?.workingHours;
  if ((input.trigger === "working_hours_open" || input.trigger === "working_hours_closed") && (!schedule || !clock.test(schedule.start) || !clock.test(schedule.end) || schedule.start === schedule.end || !validTimezone(schedule.timeZone))) throw new Response("Working-hours rules require a valid start, end and timezone", { status: 400 });
  if (input.trigger === "customer_no_response" && !input.filters?.messageClass) throw new Response("No-response rules must explicitly declare template, non_template or any message class", { status: 400 });
  const actions = (input.actions || []).map(normalizedAction);
  if (!actions.length) throw new Response("At least one governed automation action is required", { status: 400 });
  return { id, name, enabled: input.enabled === true, trigger: input.trigger, filters: { messageClass, keywords, defaultAction: input.filters?.defaultAction === true, workingHours: schedule }, actions };
}

export async function ensureWhatsAppAutomationRuleTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_automation_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,trigger TEXT NOT NULL,rule_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_automation_rule_evaluations (id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,thread_id TEXT NOT NULL,event_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,matched INTEGER NOT NULL,plan_json TEXT NOT NULL,actor_email TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_automation_rule_eval_thread_idx ON whatsapp_automation_rule_evaluations(thread_id,created_at)"),
  ]);
}

export async function saveWhatsAppAutomationRule(db: Db, input: WhatsAppAutomationRule, actorEmail: string) {
  await ensureWhatsAppAutomationRuleTables(db);
  const rule = buildWhatsAppAutomationRuleContract(input), now = Date.now();
  const prior = await db.prepare("SELECT version FROM whatsapp_automation_rules WHERE id=?").bind(rule.id).first<Row>();
  const version = Number(prior?.version || 0) + 1;
  await db.prepare("INSERT INTO whatsapp_automation_rules (id,name,status,trigger,rule_json,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,trigger=excluded.trigger,rule_json=excluded.rule_json,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(rule.id, rule.name, rule.enabled ? "active_uat" : "disabled", rule.trigger, JSON.stringify(rule), version, text(actorEmail), now).run();
  return { rule, version, environment: "uat", productionDelivery: false, externalMutation: false };
}

export async function listWhatsAppAutomationRules(db: Db) {
  await ensureWhatsAppAutomationRuleTables(db);
  const rows = await db.prepare("SELECT id,name,status,trigger,version,updated_by,updated_at FROM whatsapp_automation_rules ORDER BY updated_at DESC").all<Row>();
  return { rules: rows.results || [], productionDelivery: false, externalMutation: false };
}

export async function evaluateWhatsAppAutomationRule(db: Db, input: { ruleId: string; threadId: string; eventId: string; trigger: WhatsAppAutomationTrigger; messageText?: string; messageClass?: "template" | "non_template"; now?: number; actorEmail: string }) {
  await ensureWhatsAppAutomationRuleTables(db);
  const row = await db.prepare("SELECT rule_json,status FROM whatsapp_automation_rules WHERE id=?").bind(text(input.ruleId).toLowerCase()).first<Row>();
  if (!row || text(row.status) !== "active_uat") throw new Response("Active UAT automation rule not found", { status: 404 });
  const rule = buildWhatsAppAutomationRuleContract(parse<WhatsAppAutomationRule>(row.rule_json, {} as WhatsAppAutomationRule));
  const idempotencyKey = `whatsapp-rule:${rule.id}:${text(input.eventId)}`;
  if (!text(input.threadId) || !text(input.eventId)) throw new Response("Canonical thread and event identity are required", { status: 400 });
  const prior = await db.prepare("SELECT matched,plan_json FROM whatsapp_automation_rule_evaluations WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { matched: Number(prior.matched) === 1, plan: parse<Row[]>(prior.plan_json, []), duplicatePrevented: true, audited: true, externalMutation: false };

  let matched = rule.trigger === input.trigger;
  const filters = rule.filters || {};
  if (matched && rule.trigger === "customer_no_response") matched = filters.messageClass === "any" || filters.messageClass === input.messageClass;
  const keywords = filters.keywords || [];
  if (matched && keywords.length) {
    const body = text(input.messageText).toLowerCase();
    const keywordMatched = keywords.some((keyword) => body.includes(keyword));
    matched = keywordMatched || filters.defaultAction === true;
  }
  if (matched && (rule.trigger === "working_hours_open" || rule.trigger === "working_hours_closed")) {
    const schedule = filters.workingHours!;
    const open = inWorkingHours(input.now ?? Date.now(), schedule);
    matched = rule.trigger === "working_hours_open" ? open : !open;
  }

  const plan: Row[] = matched ? rule.actions.map((action) => {
    if (action.type === "schedule_no_response") return { ...action, durableExecutor: "whatsapp-no-response-sequence", exactlyOnceProfile: true, externalMutation: false };
    if (action.type === "route") return { ...action, requiresCanonicalAssignmentPolicy: true, directOwnershipMutation: false, externalMutation: false };
    if (action.type === "webhook" || action.type === "tool") return { ...action, authenticated: true, allowListed: true, executionBoundary: "governed_executor_required", externalMutation: false };
    if (action.type === "send_welcome" || action.type === "send_ooo") return { ...action, requiresGovernedWhatsAppOutbox: true, externalMutation: false };
    return { ...action, requiresGovernedRouting: true, externalMutation: false };
  }) : [];
  await db.prepare("INSERT INTO whatsapp_automation_rule_evaluations (id,rule_id,thread_id,event_id,idempotency_key,matched,plan_json,actor_email,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(uid("WARULEEV"), rule.id, input.threadId, input.eventId, idempotencyKey, matched ? 1 : 0, JSON.stringify(plan), text(input.actorEmail), input.now ?? Date.now()).run();
  return { matched, plan, duplicatePrevented: false, audited: true, externalMutation: false };
}
