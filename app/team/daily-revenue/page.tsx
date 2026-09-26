"use client";
import TrendChart from "../../components/ui/TrendChart";
import visual from "../../components/ui/visual-analytics.module.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/ui";
import StaffModule from "../../components/staff-workspace/StaffModule";

type Opportunity = { id: string; customer_id: string; customer_name: string | null; opportunity_type: string; reason: string; score: number; expected_revenue: number; status: string; owner: string; signals_json: string };

export default function DailyRevenuePriorityPage() {
  const [state, setState] = useState<{ opportunities: Opportunity[]; target: number; expectedRevenue: number; progressPercent: number; error: string }>({ opportunities: [], target: 0, expectedRevenue: 0, progressPercent: 0, error: "" });
  const { opportunities, target, expectedRevenue, progressPercent, error } = state;
  const [targetInput, setTargetInput] = useState(200000);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/revenue-crm", { cache: "no-store" });
      const b = (await r.json()) as { opportunities?: Opportunity[]; stats?: { dailyTarget: number; expectedRevenue: number; targetProgressPercent: number }; error?: string };
      if (!r.ok || !b.stats) throw new Error(b.error || "Unable to load");
      setState({ opportunities: b.opportunities || [], target: b.stats.dailyTarget, expectedRevenue: b.stats.expectedRevenue, progressPercent: b.stats.targetProgressPercent, error: "" });
      setTargetInput(b.stats.dailyTarget);
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Unable to load" }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveTarget() {
    setBusy(true);
    try {
      const r = await fetch("/api/revenue-crm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set_daily_target", targetAmount: targetInput }) });
      const b = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error || "Unable to set target");
      setNotice(`Daily target set to ₹${targetInput.toLocaleString("en-IN")}`);
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Unable to set target" }));
    } finally {
      setBusy(false);
    }
  }

  async function claim(id: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/revenue-crm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claim_opportunity", id }) });
      const b = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error || "Unable to claim");
      setNotice("Opportunity claimed");
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Unable to claim" }));
    } finally {
      setBusy(false);
    }
  }

  const valueBasisLabel = (row: Opportunity) => {
    try {
      const basis = (JSON.parse(row.signals_json || "{}") as { valueBasis?: string }).valueBasis;
      if (basis === "actual_subscription_price") return "actual price";
      if (basis === "inbound_lead_catalogue_average_estimate") return "estimate";
      if (basis === "customer_scoring_model") return "modelled";
      return "";
    } catch { return ""; }
  };

  return (
    <StaffModule><main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px", fontFamily: "inherit" }}>
      <p><Link href="/team">← Team</Link></p>
      <p style={{ fontWeight: 800, letterSpacing: 1 }}>PAWSPACE · DAILY REVENUE PRIORITY</p>
      <h1>Today&apos;s prioritised revenue opportunities</h1>
      <p style={{ color: "var(--staff-muted)" }}>Real customer scoring, real open inbound leads and real subscription renewals - not fabricated demo rows. Lead values are disclosed estimates from the grooming catalogue average; renewal values are each customer&apos;s actual original price.</p>
      {error && <div style={{ padding: 12, background: "var(--staff-danger-bg)", border: "1px solid var(--staff-line)", borderRadius: 10, margin: "12px 0" }}>{error}</div>}
      {notice && <div style={{ padding: 12, background: "var(--staff-success-bg)", border: "1px solid var(--staff-line)", borderRadius: 10, margin: "12px 0" }}>{notice}</div>}

      <section style={{ border: "1px solid var(--staff-line)", borderRadius: 12, padding: 20, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Today&apos;s target</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
          <div>
            <b style={{ fontSize: 24 }}>₹{expectedRevenue.toLocaleString("en-IN")}</b>
            <span style={{ color: "var(--staff-muted)" }}> of ₹{target.toLocaleString("en-IN")} ({progressPercent}%)</span>
          </div>
        </div>
        <div style={{ background: "var(--staff-line)", borderRadius: 8, height: 10, overflow: "hidden" }}>
          <div style={{ background: progressPercent >= 100 ? "var(--staff-success)" : "var(--staff-primary)", height: "100%", width: `${Math.min(100, progressPercent)}%` }} />
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
          <label>Set target (₹)<br /><input type="number" min={1} value={targetInput} onChange={(e) => setTargetInput(Number(e.target.value))} style={{ width: 200, padding: 8 }} /></label>
          <button disabled={busy} onClick={() => void saveTarget()} style={{ padding: "10px 16px", marginTop: 22 }}>Save target</button>
        </div>
      </section>

      {!error && opportunities.length > 0 && <section className={visual.panel}><span className={visual.eyebrow}>OPPORTUNITY INTELLIGENCE</span><h2>Where the pipeline value sits</h2><p className={visual.muted}>Current opportunity snapshot · expected values are estimates or modelled amounts, not collected revenue. Historical opportunity snapshots are not available for date comparisons.</p><div className={visual.grid}><article className={visual.chart}><h3>Expected value by opportunity type</h3><TrendChart type="bar" data={Object.entries(opportunities.reduce<Record<string, number>>((totals, row) => { totals[row.opportunity_type] = (totals[row.opportunity_type] || 0) + row.expected_revenue; return totals; }, {})).map(([type, value]) => ({ type: type.replaceAll("_", " "), value }))} xKey="type" series={[{ key: "value", label: "Expected value" }]} valueFormatter={value => `₹${value.toLocaleString("en-IN")}`} /></article><article className={visual.chart}><h3>Pipeline status</h3><TrendChart type="bar" data={Object.entries(opportunities.reduce<Record<string, number>>((totals, row) => { totals[row.status] = (totals[row.status] || 0) + 1; return totals; }, {})).map(([status, count]) => ({ status, count }))} xKey="status" series={[{ key: "count", label: "Opportunities" }]} /></article></div></section>}
      <section style={{ marginTop: 24 }}>
        <h2>Prioritised list ({opportunities.length})</h2>
        {!opportunities.length && <EmptyState title="No opportunities generated yet" body="This list is built from real customer scoring, open inbound leads and subscription renewals due. It fills once leads exist and a daily target is set above." action={<Link href="/team/sales" style={{fontWeight:700}}>Open the customer worklist →</Link>} />}
        {opportunities.map((row) => (
          <article key={row.id} style={{ border: "1px solid var(--staff-line)", borderRadius: 10, padding: 12, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <b>{row.customer_name || row.customer_id}</b> · {row.opportunity_type} · <span style={{ color: "var(--staff-muted)" }}>{row.reason}</span>
              <br /><span style={{ fontSize: 15, color: "var(--staff-muted)" }}>₹{row.expected_revenue.toLocaleString("en-IN")} ({valueBasisLabel(row)}) · score {row.score} · owner {row.owner} · {row.status}</span>
            </div>
            {row.status === "ready" && <button disabled={busy} onClick={() => void claim(row.id)} style={{ padding: "8px 14px", flexShrink: 0 }}>Claim</button>}
          </article>
        ))}
      </section>
    </main></StaffModule>
  );
}
