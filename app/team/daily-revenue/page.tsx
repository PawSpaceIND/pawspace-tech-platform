"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/ui";
import { buildTodaysListRequest } from "./build-request";

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

  /* The empty state said "It fills once leads exist and a daily target is set above." Both were
   * true on a live deployment - four open leads, a INR 50,000 target - and the list stayed at zero,
   * because the thing that BUILDS the list is the generate_daily_100 action and this page posted
   * only set_daily_target and claim_opportunity. Called directly it returned {"created":4} and the
   * board rendered four claimable opportunities. The control was the only missing part. */
  async function generateList() {
    setBusy(true);
    try {
      const request = buildTodaysListRequest();
      const r = await fetch(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) });
      const b = (await r.json()) as { ok?: boolean; created?: number; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error || "Unable to build today's list");
      setNotice(typeof b.created === "number"
        ? (b.created > 0 ? `Built today's list: ${b.created} opportunit${b.created === 1 ? "y" : "ies"} ranked.` : "Nothing to rank right now: no open lead, due renewal or scored customer action qualifies today.")
        : "Today's list was rebuilt.");
      setState((s) => ({ ...s, error: "" }));
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Unable to build today's list" }));
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
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui,sans-serif" }}>
      <p><Link href="/team">← Team</Link></p>
      <p style={{ fontWeight: 800, letterSpacing: 1 }}>PAWSPACE · DAILY REVENUE PRIORITY</p>
      <h1>Today&apos;s prioritised revenue opportunities</h1>
      <p style={{ color: "#666" }}>Real customer scoring, real open inbound leads and real subscription renewals - not fabricated demo rows. Lead values are disclosed estimates from the grooming catalogue average; renewal values are each customer&apos;s actual original price.</p>
      {error && <div style={{ padding: 12, background: "#fff1f1", border: "1px solid #efc2c2", borderRadius: 10, margin: "12px 0" }}>{error}</div>}
      {notice && <div style={{ padding: 12, background: "#eefaf1", border: "1px solid #b8e6c5", borderRadius: 10, margin: "12px 0" }}>{notice}</div>}

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 20, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Today&apos;s target</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
          {/* This read "INR 7,148 of INR 50,000" as though 7,148 had been earned. It is the summed
              EXPECTED value of the opportunities still on today's list - unconverted lead estimates
              and renewals due - so it is pipeline, not revenue, and the label now says so. */}
          <div>
            <b style={{ fontSize: 24 }}>₹{expectedRevenue.toLocaleString("en-IN")}</b>
            <span style={{ color: "#666" }}> of ₹{target.toLocaleString("en-IN")} target ({progressPercent}%)</span>
            <br /><small style={{ color: "#666" }}>Expected value of today&apos;s open opportunities, not revenue collected. Nothing here is booked until an opportunity is claimed and completed.</small>
          </div>
        </div>
        <div style={{ background: "#eee", borderRadius: 8, height: 10, overflow: "hidden" }}>
          <div style={{ background: progressPercent >= 100 ? "#2e7d4f" : "#4c8bf5", height: "100%", width: `${Math.min(100, progressPercent)}%` }} />
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
          <label>Set target (₹)<br /><input type="number" min={1} value={targetInput} onChange={(e) => setTargetInput(Number(e.target.value))} style={{ width: 200, padding: 8 }} /></label>
          <button disabled={busy} onClick={() => void saveTarget()} style={{ padding: "10px 16px", marginTop: 22 }}>Save target</button>
          <button disabled={busy} onClick={() => void generateList()} style={{ padding: "10px 16px", marginTop: 22 }}>{busy ? "Working…" : "Build today's list"}</button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Prioritised list ({opportunities.length})</h2>
        {!opportunities.length && <EmptyState title="No opportunities generated yet" body="This list is built from real customer scoring, open inbound leads and subscription renewals due. It does not build itself here — press Build today's list above, and it will rank whatever qualifies right now." action={<Link href="/team/sales" style={{fontWeight:700}}>Open the customer worklist →</Link>} />}
        {opportunities.map((row) => (
          <article key={row.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <b>{row.customer_name || row.customer_id}</b> · {row.opportunity_type} · <span style={{ color: "#666" }}>{row.reason}</span>
              <br /><span style={{ fontSize: 13, color: "#888" }}>₹{row.expected_revenue.toLocaleString("en-IN")} ({valueBasisLabel(row)}) · score {row.score} · owner {row.owner} · {row.status}</span>
            </div>
            {row.status === "ready" && <button disabled={busy} onClick={() => void claim(row.id)} style={{ padding: "8px 14px", flexShrink: 0 }}>Claim</button>}
          </article>
        ))}
      </section>
    </main>
  );
}
