"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type Rule = { id: string; name: string; serviceCode: string; cityId: string; ruleType: string; adjustmentType: string; adjustmentValue: number; effectiveFrom: string; effectiveTo: string | null; status: string };
type Sug = { name: string; serviceCode: string; cityId: string; effectiveFrom: string; effectiveTo: string; adjustmentValue: number; lengthDays: number; holidays: string[] };
type City = { cityId: string; label: string; source: string };
type RuleType = "weekend" | "time_band" | "weekday" | "season" | "date_range";

const wrap = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" } as const;
const card = { background: "white", border: "1px solid #e5dcef", borderRadius: 14 } as const;
const field: React.CSSProperties = { padding: "9px 10px", border: "1px solid #d9cfe8", borderRadius: 9, font: "inherit", color: "inherit", background: "white", width: "100%" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "#6c39a8", marginBottom: 4 };
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
// Sunday-indexed to match the pricing engine's day numbering (lib/pricing-engine.ts isoDay).
const DAYS = [{ n: 0, s: "Sun" }, { n: 1, s: "Mon" }, { n: 2, s: "Tue" }, { n: 3, s: "Wed" }, { n: 4, s: "Thu" }, { n: 5, s: "Fri" }, { n: 6, s: "Sat" }];
const WEEKEND_DAYS = [0, 6];
const YEAR = 2026;
const today = () => new Date().toISOString().slice(0, 10);

// What each rule type actually needs, mirroring the server-side validation in
// lib/pricing-rule-governance.ts. The engine matches on days/times/dates and ignores rule_type, so a
// rule saved without them would silently apply to every slot.
const NEEDS: Record<RuleType, { days: boolean; times: boolean; endDate: boolean; hint: string }> = {
  weekend: { days: true, times: false, endDate: false, hint: "Applies on the selected weekend days. Saturday and Sunday are pre-selected." },
  weekday: { days: true, times: false, endDate: false, hint: "Pick the weekdays this rule applies to." },
  time_band: { days: false, times: true, endDate: false, hint: "Applies only between the start and end time (IST). Optionally narrow it to specific days too." },
  season: { days: false, times: false, endDate: true, hint: "Applies across a season window — an end date is required so the surcharge expires." },
  date_range: { days: false, times: false, endDate: true, hint: "Applies between two dates only." },
};

export default function PricingRulesPage() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [sugs, setSugs] = useState<Sug[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // controlled form state — the rule type drives which inputs are shown and submitted
  const [ruleType, setRuleType] = useState<RuleType>("weekend");
  const [cityId, setCityId] = useState("");
  const [days, setDays] = useState<number[]>(WEEKEND_DAYS);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("12:00");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  // derived rather than assigned in an effect: until the operator picks one, the first loaded city
  // is the selection, so the picker is never blank and no cascading render is triggered
  const selectedCity = cityId || cities[0]?.cityId || "";

  async function load() {
    const r = await fetch("/api/pricing-rules", { cache: "no-store" });
    const b = await r.json() as { data?: Rule[]; error?: string };
    if (!r.ok) throw new Error(b.error || "Pricing unavailable");
    setRows(b.data || []);
  }
  useEffect(() => {
    let on = true;
    // fetches are inlined (not calls into the setState helpers above) so nothing sets state
    // synchronously while the effect runs — same pattern as the other team pages
    void Promise.all([
      fetch("/api/pricing-rules", { cache: "no-store" }).then(r => r.json() as Promise<{ data?: Rule[]; error?: string }>),
      fetch("/api/pricing-rules?mode=cities", { cache: "no-store" }).then(r => r.json() as Promise<{ data?: City[]; error?: string }>),
    ]).then(([ruleBody, cityBody]) => {
      if (!on) return;
      if (ruleBody.error) throw new Error(ruleBody.error);
      setRows(ruleBody.data || []);
      setCities(cityBody.data || []);
    }).catch(e => { if (on) setError(e instanceof Error ? e.message : "Pricing unavailable"); });
    return () => { on = false; };
  }, []);

  // switching rule type resets the type-specific inputs to that type's sensible default
  function changeRuleType(next: RuleType) {
    setRuleType(next);
    setDays(next === "weekend" ? WEEKEND_DAYS : next === "weekday" ? [1, 2, 3, 4, 5] : []);
    if (!NEEDS[next].endDate) setEffectiveTo("");
  }
  const toggleDay = (n: number) => setDays(current => current.includes(n) ? current.filter(d => d !== n) : [...current, n].sort());

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/pricing-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json() as { error?: string };
    if (!r.ok) throw new Error(b.error || "Action failed");
  }
  async function suggest() {
    setBusy(true); setError("");
    try {
      await post({ action: "seed_holidays", year: YEAR });
      const r = await fetch(`/api/pricing-rules?mode=suggest&year=${YEAR}&serviceCode=boarding&cityId=${encodeURIComponent(selectedCity || "blr")}&pct=20`, { cache: "no-store" });
      const b = await r.json() as { data?: Sug[]; error?: string };
      if (!r.ok) throw new Error(b.error || "Suggest failed");
      setSugs(b.data || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Suggest failed"); } finally { setBusy(false); }
  }
  async function apply(s: Sug) {
    setBusy(true); setError("");
    try {
      await post({ action: "apply_suggestion", name: s.name, serviceCode: s.serviceCode, cityId: s.cityId, startDate: s.effectiveFrom, endDate: s.effectiveTo, adjustmentPercent: s.adjustmentValue });
      setSugs(prev => prev.filter(x => x !== s));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Apply failed"); } finally { setBusy(false); }
  }

  function validate(needs: typeof NEEDS[RuleType]) {
    if (!selectedCity) return "Select a city.";
    if (needs.days && !days.length) return `A ${ruleType} rule needs at least one day selected.`;
    if (needs.times && (!startTime || !endTime)) return "A time band needs a start and an end time.";
    if (needs.times && startTime >= endTime) return "The start time must be earlier than the end time.";
    if (needs.endDate && !effectiveTo) return `A ${ruleType} rule needs an end date.`;
    if (effectiveTo && effectiveTo < effectiveFrom) return "The end date cannot be before the start date.";
    return "";
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, fd = new FormData(form), needs = NEEDS[ruleType];
    const problem = validate(needs);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      await post({
        action: "create_rule",
        name: String(fd.get("name")),
        serviceCode: String(fd.get("serviceCode")),
        cityId: selectedCity,
        zoneId: String(fd.get("zoneId") || "").trim() || undefined,
        ruleType,
        // only send what this rule type actually means — the engine matches on these fields
        days: needs.days || (ruleType === "time_band" && days.length) ? days : [],
        startTime: needs.times ? startTime : undefined,
        endTime: needs.times ? endTime : undefined,
        effectiveFrom,
        effectiveTo: effectiveTo || undefined,
        adjustmentType: "percent",
        adjustmentValue: Number(fd.get("adjustmentValue")),
      });
      form.reset();
      changeRuleType(ruleType);
      setEffectiveFrom(today());
      await load();
    } catch (x) { setError(x instanceof Error ? x.message : "Create failed"); } finally { setBusy(false); }
  }

  const needs = NEEDS[ruleType];
  return <main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}>
      <div><small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · DYNAMIC PRICING</small><h1 style={{ margin: "7px 0" }}>Rules &amp; holiday surcharge</h1><p style={{ margin: 0, color: "#746b7d" }}>City/zone rules (weekend, time band, weekday, season, date-range) + long-weekend auto-suggest for {YEAR}.</p></div>
      <div style={{ display: "flex", gap: 8 }}><button type="button" disabled={busy} onClick={suggest} style={{ padding: 10, background: "#E6B34E", color: "#041517", border: 0, borderRadius: 10, fontWeight: 800 }}>{busy ? "…" : `Suggest ${YEAR} long weekends`}</button><Link href="/team" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>Team home</Link></div>
    </header>
    {error && <div role="alert" style={{ padding: 12, background: "#fff1f1", borderRadius: 10, marginBottom: 12 }}>{error}</div>}
    {sugs.length > 0 && <div style={{ ...card, padding: 14, marginBottom: 16, background: "#fffaf0" }}><b>Suggested surcharge windows (boarding · {selectedCity || "blr"} · +20%)</b>{sugs.map((s, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f0ebf4" }}><div><strong>{s.effectiveFrom} → {s.effectiveTo}</strong> <small style={{ color: "#746b7d" }}>· {s.lengthDays} days · {s.holidays.join(", ")}</small></div><button type="button" disabled={busy} onClick={() => apply(s)} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 8, fontWeight: 800, padding: "7px 12px" }}>Apply +{s.adjustmentValue}%</button></div>)}</div>}

    <form onSubmit={create} style={{ ...card, padding: 18, marginBottom: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
        <label><span style={labelStyle}>Rule name</span><input name="name" required placeholder="e.g. Weekend morning uplift" style={field} /></label>
        <label><span style={labelStyle}>Service</span><select name="serviceCode" required defaultValue="grooming" style={field}>{SERVICES.map(s => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select></label>
        <label><span style={labelStyle}>City</span>
          <select name="cityId" required value={selectedCity} onChange={e => setCityId(e.target.value)} style={field}>
            {cities.length === 0 ? <option value="">No cities configured</option> : cities.map(c => <option key={c.cityId} value={c.cityId}>{c.cityId} — {c.label}</option>)}
          </select>
        </label>
        <label><span style={labelStyle}>Zone (optional)</span><input name="zoneId" placeholder="all zones" style={field} /></label>
        <label><span style={labelStyle}>Rule type</span>
          <select name="ruleType" required value={ruleType} onChange={e => changeRuleType(e.target.value as RuleType)} style={field}>
            {(Object.keys(NEEDS) as RuleType[]).map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
        </label>
        <label><span style={labelStyle}>Adjustment %</span><input name="adjustmentValue" type="number" step="0.5" required placeholder="+15 or -10" style={field} /></label>
      </div>

      <p style={{ margin: 0, fontSize: 13, color: "#746b7d" }}>{needs.hint}</p>

      {(needs.days || ruleType === "time_band") && <div>
        <span style={labelStyle}>{needs.days ? "Days this rule applies" : "Limit to days (optional)"}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {DAYS.map(d => {
            const on = days.includes(d.n);
            return <button key={d.n} type="button" onClick={() => toggleDay(d.n)} aria-pressed={on} style={{ padding: "7px 13px", borderRadius: 999, cursor: "pointer", fontWeight: 700, border: on ? "1px solid #4b168c" : "1px solid #d9cfe8", background: on ? "#4b168c" : "white", color: on ? "white" : "#24133f" }}>{d.s}</button>;
          })}
        </div>
      </div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
        {needs.times && <>
          <label><span style={labelStyle}>Start time (IST)</span><input name="startTime" type="time" required value={startTime} onChange={e => setStartTime(e.target.value)} style={field} /></label>
          <label><span style={labelStyle}>End time (IST)</span><input name="endTime" type="time" required value={endTime} onChange={e => setEndTime(e.target.value)} style={field} /></label>
        </>}
        <label><span style={labelStyle}>Effective from</span><input name="effectiveFrom" type="date" required value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} style={field} /></label>
        <label><span style={labelStyle}>Effective to {needs.endDate ? "" : "(optional)"}</span><input name="effectiveTo" type="date" required={needs.endDate} min={effectiveFrom} value={effectiveTo} onChange={e => setEffectiveTo(e.target.value)} style={field} /></label>
      </div>

      <div><button disabled={busy || !selectedCity} style={{ background: "#F6920A", color: "white", border: 0, borderRadius: 9, fontWeight: 800, padding: "11px 20px", cursor: busy ? "wait" : "pointer" }}>{busy ? "Saving…" : "Add rule"}</button>
        <small style={{ marginLeft: 12, color: "#746b7d" }}>Rules are created as <b>draft</b> — publishing stays a separate governed step.</small></div>
    </form>

    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: 14, borderBottom: "1px solid #eee6f5" }}><b>{rows.length} rule{rows.length === 1 ? "" : "s"}</b></div>
      {rows.length === 0 ? <p style={{ padding: 18, color: "#746b7d" }}>No rules yet.</p> : rows.map(p => <article key={p.id} style={{ padding: 14, borderBottom: "1px solid #f0ebf4", display: "flex", justifyContent: "space-between", gap: 12 }}><div><strong>{p.name}</strong> <small style={{ color: "#746b7d" }}>· {p.serviceCode} · {p.cityId} · {p.ruleType}</small><small style={{ display: "block", marginTop: 3, color: "#746b7d" }}>{p.effectiveFrom}{p.effectiveTo ? ` → ${p.effectiveTo}` : ""} · {p.status}</small></div><div style={{ fontWeight: 800, fontSize: 16 }}>{p.adjustmentValue > 0 ? "+" : ""}{p.adjustmentValue}%</div></article>)}
    </div>
  </div></main>;
}
