/**
 * Governed dynamic-pricing rules for ANY city/zone, plus a holiday / long-weekend surcharge auto-suggester.
 *
 * The pricing engine already supports weekend / time_band (slot) / weekday / season / date_range rules;
 * what was missing was (a) creating them city/zone-wise (the old admin hardcoded Bangalore) and (b)
 * *suggesting* the long-weekend windows for a year so ops don't have to hunt them down. This module adds
 * both, writing to the same `dynamic_pricing_rules` the live engine reads. Suggestions are advisory -
 * a human approves each into a real rule (nothing auto-applies a surcharge). Cold-DB safe + audited.
 */

import { ensurePricingControlSchema } from "./pricing-control-runtime";

type Db = D1Database;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toLowerCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });
const DAY = 86_400_000;
const RULE_TYPES = ["weekday", "weekend", "time_band", "season", "date_range"];
const ADJUSTMENTS = ["percent", "fixed", "override"];
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parseDay = (d: string) => Date.parse(d + "T00:00:00Z");

export async function ensurePricingRuleTables(db: Db) {
  await ensurePricingControlSchema(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS holiday_calendar (id TEXT PRIMARY KEY,region TEXT NOT NULL,date TEXT NOT NULL,name TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(region,date))").run();
}

/** Create a dynamic pricing rule for any service, city and zone. Draft by default (human publishes). */
export async function createPricingRule(db: Db, input: { name: string; serviceCode: string; packageCode?: string; cityId: string; zoneId?: string; ruleType: string; days?: number[]; startTime?: string; endTime?: string; effectiveFrom: string; effectiveTo?: string; adjustmentType: string; adjustmentValue: number; couponPolicy?: string; priority?: number; actorId: string }) {
  await ensurePricingRuleTables(db);
  const name = text(input.name), serviceCode = text(input.serviceCode), cityId = text(input.cityId), ruleType = text(input.ruleType), adjustmentType = text(input.adjustmentType);
  if (!name || !serviceCode || !cityId) throw new Error("name, serviceCode and cityId are required");
  if (!RULE_TYPES.includes(ruleType)) throw new Error(`ruleType must be one of: ${RULE_TYPES.join(", ")}`);
  if (!ADJUSTMENTS.includes(adjustmentType)) throw new Error(`adjustmentType must be one of: ${ADJUSTMENTS.join(", ")}`);
  if (!Number.isFinite(Number(input.adjustmentValue))) throw new Error("A valid adjustmentValue is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(input.effectiveFrom))) throw new Error("effectiveFrom must be YYYY-MM-DD");
  const id = uid("price_rule"), now = Date.now();
  await db.prepare("INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',1,?,?)")
    .bind(id, name, serviceCode, text(input.packageCode) || null, cityId, text(input.zoneId) || null, ruleType, JSON.stringify(input.days || []), text(input.startTime) || null, text(input.endTime) || null, text(input.effectiveFrom), text(input.effectiveTo) || null, adjustmentType, Number(input.adjustmentValue), text(input.couponPolicy) || "stackable", Number(input.priority) || 100, input.actorId, now).run();
  const row = await db.prepare("SELECT * FROM dynamic_pricing_rules WHERE id=?").bind(id).first<Row>();
  return { id, ...shape(row!) };
}

const shape = (r: Row) => ({ name: String(r.name), serviceCode: String(r.service_code), cityId: String(r.city_id), zoneId: r.zone_id ? String(r.zone_id) : null, ruleType: String(r.rule_type), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null, adjustmentType: String(r.adjustment_type), adjustmentValue: Number(r.adjustment_value), priority: Number(r.priority), status: String(r.status) });

export async function listPricingRules(db: Db, input: { serviceCode?: string; cityId?: string } = {}) {
  await ensurePricingRuleTables(db);
  const clauses: string[] = ["1=1"], binds: unknown[] = [];
  if (input.serviceCode) { clauses.push("service_code=?"); binds.push(text(input.serviceCode)); }
  if (input.cityId) { clauses.push("city_id=?"); binds.push(text(input.cityId)); }
  const rows = await db.prepare(`SELECT * FROM dynamic_pricing_rules WHERE ${clauses.join(" AND ")} ORDER BY priority,effective_from`).bind(...binds).all<Row>().catch(empty);
  return rows.results.map(r => ({ id: String(r.id), ...shape(r) }));
}

// --- Holiday calendar ---
export async function addHoliday(db: Db, input: { region: string; date: string; name: string; actorId: string }) {
  await ensurePricingRuleTables(db);
  const region = text(input.region) || "IN", date = text(input.date), name = text(input.name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) throw new Error("A valid date (YYYY-MM-DD) and name are required");
  await db.prepare("INSERT OR IGNORE INTO holiday_calendar (id,region,date,name,created_by,created_at) VALUES (?,?,?,?,?,?)").bind(uid("hol"), region, date, name, input.actorId, Date.now()).run();
  return { region, date, name };
}

/** Seed the fixed-date national holidays for a year (festivals with moving dates are added by ops). */
export async function seedNationalHolidays(db: Db, input: { year: number; region?: string; actorId?: string }) {
  await ensurePricingRuleTables(db);
  const region = text(input.region) || "IN", y = Number(input.year), actorId = text(input.actorId) || "system_seed";
  const fixed = [[`${y}-01-26`, "Republic Day"], [`${y}-08-15`, "Independence Day"], [`${y}-10-02`, "Gandhi Jayanti"]];
  for (const [date, name] of fixed) await db.prepare("INSERT OR IGNORE INTO holiday_calendar (id,region,date,name,created_by,created_at) VALUES (?,?,?,?,?,?)").bind(uid("hol"), region, date, name, actorId, Date.now()).run();
  return { region, year: y, seeded: fixed.length };
}

export async function listHolidays(db: Db, input: { region?: string; year?: number } = {}) {
  await ensurePricingRuleTables(db);
  const region = text(input.region) || "IN";
  const rows = await db.prepare("SELECT date,name FROM holiday_calendar WHERE region=? AND (?='' OR substr(date,1,4)=?) ORDER BY date").bind(region, input.year ? String(input.year) : "", input.year ? String(input.year) : "").all<Row>().catch(empty);
  return rows.results.map(r => ({ date: String(r.date), name: String(r.name) }));
}

/** Detect long-weekend windows for a year: consecutive runs of non-working days (weekend OR holiday)
 * of length >= 3. Each becomes a suggested surcharge window. Pure computation, nothing persisted. */
export async function suggestLongWeekendWindows(db: Db, input: { region?: string; year: number }) {
  await ensurePricingRuleTables(db);
  const region = text(input.region) || "IN", y = Number(input.year);
  const holidays = new Map((await listHolidays(db, { region, year: y })).map(h => [h.date, h.name]));
  const start = parseDay(`${y}-01-01`), end = parseDay(`${y}-12-31`);
  const runs: { startDate: string; endDate: string; lengthDays: number; holidays: string[] }[] = [];
  let cur: { startT: number; endT: number; holidays: string[] } | null = null;
  for (let t = start; t <= end; t += DAY) {
    const d = iso(t), dow = new Date(t).getUTCDay(), isHoliday = holidays.has(d), nonWorking = dow === 0 || dow === 6 || isHoliday;
    if (nonWorking) { if (!cur) cur = { startT: t, endT: t, holidays: [] }; else cur.endT = t; if (isHoliday) cur.holidays.push(`${d} ${holidays.get(d)}`); }
    else if (cur) { const len = Math.round((cur.endT - cur.startT) / DAY) + 1; if (len >= 3 && cur.holidays.length) runs.push({ startDate: iso(cur.startT), endDate: iso(cur.endT), lengthDays: len, holidays: cur.holidays }); cur = null; }
  }
  if (cur) { const len = Math.round((cur.endT - cur.startT) / DAY) + 1; if (len >= 3 && cur.holidays.length) runs.push({ startDate: iso(cur.startT), endDate: iso(cur.endT), lengthDays: len, holidays: cur.holidays }); }
  return runs;
}

/** Auto-suggest surcharge rules (advisory) for a service/city over the year's long weekends. */
export async function suggestSurcharge(db: Db, input: { region?: string; year: number; serviceCode: string; cityId: string; zoneId?: string; adjustmentPercent?: number }) {
  const windows = await suggestLongWeekendWindows(db, { region: input.region, year: input.year });
  const pct = Number(input.adjustmentPercent) || 20;
  return windows.map(w => ({ name: `Long weekend surcharge (${w.holidays.map(h => h.split(" ").slice(1).join(" ")).join(", ")})`, serviceCode: text(input.serviceCode), cityId: text(input.cityId), zoneId: text(input.zoneId) || null, ruleType: "date_range", effectiveFrom: w.startDate, effectiveTo: w.endDate, adjustmentType: "percent", adjustmentValue: pct, lengthDays: w.lengthDays, holidays: w.holidays, suggestion: true }));
}

/** Approve one suggestion into a real (draft) pricing rule. */
export async function applySurchargeSuggestion(db: Db, input: { name: string; serviceCode: string; cityId: string; zoneId?: string; startDate: string; endDate: string; adjustmentPercent: number; priority?: number; actorId: string }) {
  return createPricingRule(db, { name: text(input.name) || "Long weekend surcharge", serviceCode: input.serviceCode, cityId: input.cityId, zoneId: input.zoneId, ruleType: "date_range", effectiveFrom: input.startDate, effectiveTo: input.endDate, adjustmentType: "percent", adjustmentValue: Number(input.adjustmentPercent) || 20, priority: input.priority ?? 50, actorId: input.actorId });
}
