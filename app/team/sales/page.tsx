"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatCard, EmptyState } from "../../components/ui";

type Customer = Record<string, unknown> & {
  customerId: string; name: string; primaryPhone: string; crmStage: string; owner: string;
  lifetimeValue: number; openTicketCount: number;
  dataQuality: { score: number; issues: string[] };
  consent: { marketing: boolean; service: boolean };
  pets: Record<string, unknown>[]; bookings: Record<string, unknown>[];
};
type Action = Record<string, unknown> & {
  id: string; customer_id?: string; customerId?: string; reason?: string; score?: number;
  expected_revenue?: number; status?: string; suppression_json?: string;
};

const ink = "#1A1A1A";
const forest = "#01261F";
const gold = "#E6B34E";
const ivory = "#F4F1EA";
const card = { background: "#FFF8EE", border: "1px solid #D9D1C4", borderRadius: 16 };

export default function TeamSales() {
  const [customers, setCustomers] = useState<Customer[]>([]), [actions, setActions] = useState<Action[]>([]),
    [selected, setSelected] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const [c, a] = await Promise.all([fetch("/api/customer-360", { cache: "no-store" }), fetch("/api/revenue-intelligence", { cache: "no-store" })]);
    const cb = await c.json() as { data?: { records: Customer[] }; error?: string };
    const ab = await a.json() as { data?: { actions: Action[] }; error?: string };
    if (!c.ok) throw new Error(cb.error || "Customer 360 unavailable");
    if (!a.ok) throw new Error(ab.error || "Revenue intelligence unavailable");
    setCustomers(cb.data?.records || []);
    setActions(ab.data?.actions || []);
    setSelected(x => x || cb.data?.records?.[0]?.customerId || "");
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([fetch("/api/customer-360", { cache: "no-store" }), fetch("/api/revenue-intelligence", { cache: "no-store" })]).then(async ([c, a]) => {
      const cb = await c.json() as { data?: { records: Customer[] }; error?: string };
      const ab = await a.json() as { data?: { actions: Action[] }; error?: string };
      if (!c.ok) throw new Error(cb.error || "Customer 360 unavailable");
      if (!a.ok) throw new Error(ab.error || "Revenue intelligence unavailable");
      if (active) {
        const records = cb.data?.records || [];
        setCustomers(records);
        setActions(ab.data?.actions || []);
        if (records[0]) setSelected(records[0].customerId);
      }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : "CRM unavailable"); });
    return () => { active = false; };
  }, []);
  const current = useMemo(() => customers.find(c => c.customerId === selected) || customers[0], [customers, selected]);
  const customerActions = useMemo(() => actions.filter(a => String(a.customer_id || a.customerId) === current?.customerId), [actions, current]);
  async function revenue(action: string, id: string) {
    setBusy(id);
    try {
      const r = await fetch("/api/revenue-intelligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id, outcome: action === "complete" ? "staff_completed" : undefined }) });
      const b = await r.json() as { error?: string };
      if (!r.ok) throw new Error(b.error || "Action failed");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(""); }
  }
  return (
    <main style={{ minHeight: "100vh", background: ivory, padding: 28, fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif", color: ink }}>
      <div style={{ maxWidth: 1500, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20 }}>
          <div>
            <small style={{ fontWeight: 800, color: forest, letterSpacing: 0.6 }}>PAWSPACE TEAM · SALES & CRM</small>
            <h1 style={{ margin: "7px 0", color: forest, fontSize: 28 }}>Canonical Customer 360 & Revenue worklist</h1>
            <p style={{ margin: 0, color: "#3D4A46" }}>One customer/pet/service/CX/consent record. Revenue scores are UAT rule-based estimates; margin remains configuration-required.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/team/customer-experience" style={{ padding: "10px 14px", textDecoration: "none", color: forest, fontWeight: 700, ...card }}>CX inbox</Link>
            <Link href="/team" style={{ padding: "10px 14px", textDecoration: "none", background: forest, color: "#FFF8EE", borderRadius: 10, fontWeight: 700 }}>Team home</Link>
          </div>
        </header>
        {error && <div style={{ padding: 12, background: "#FDECEC", border: "1px solid #E8B4B4", borderRadius: 10, marginBottom: 14 }}>{error}</div>}
        <section style={{ display: "grid", gridTemplateColumns: "minmax(330px,.8fr) minmax(600px,1.5fr)", gap: 16 }}>
          <aside style={{ ...card, overflow: "hidden" }}>
            <div style={{ padding: 15, borderBottom: "1px solid #E6DED2" }}>
              <b>Customers</b>
              <small style={{ display: "block", marginTop: 4, color: "#3D4A46" }}>{customers.length} canonical/CRM record(s)</small>
            </div>
            {customers.map(c => (
              <button key={c.customerId} onClick={() => setSelected(c.customerId)} style={{ display: "block", width: "100%", textAlign: "left", padding: 14, border: 0, borderBottom: "1px solid #E6DED2", background: selected === c.customerId ? "#E8F0EC" : "#FFF8EE", color: ink, cursor: "pointer" }}>
                <strong style={{ color: forest }}>{c.name}</strong>
                <div style={{ fontSize: 12, marginTop: 4 }}>{c.primaryPhone} · {c.crmStage} · {c.owner}</div>
                <small style={{ display: "block", marginTop: 4, color: c.dataQuality.score < 80 ? "#9a5b00" : "#3D4A46" }}>Data quality {c.dataQuality.score}/100 · {c.openTicketCount} open CX</small>
              </button>
            ))}
          </aside>
          <article style={{ ...card, padding: 20 }}>
            {!current ? (
              <EmptyState title="No customer records yet" body="Customer 360 merges CRM contacts with canonical customers. A record appears here as soon as someone is added in the CRM, or as soon as a booking is confirmed for them." action={<Link href="/crm" style={{ fontWeight: 700, color: forest }}>Add a lead in the CRM →</Link>} />
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 15, borderBottom: "1px solid #E6DED2", paddingBottom: 14 }}>
                  <div>
                    <small>{current.customerId}</small>
                    <h2 style={{ margin: "5px 0", color: forest }}>{current.name}</h2>
                    <p style={{ margin: 0 }}>{current.primaryPhone} · owner {current.owner}</p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <b style={{ color: gold, fontSize: 22 }}>₹{Number(current.lifetimeValue || 0).toLocaleString("en-IN")}</b>
                    <small style={{ display: "block" }}>canonical booked value</small>
                  </div>
                </div>
                <section style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, margin: "16px 0" }}>
                  {[["Pets", current.pets.length], ["Bookings", current.bookings.length], ["Open CX", current.openTicketCount], ["Quality", `${current.dataQuality.score}/100`]].map(([k, v]) => <StatCard key={String(k)} label={String(k)} value={v} />)}
                </section>
                <div style={{ padding: 12, borderRadius: 10, background: "#E8F0EC", marginBottom: 16 }}>
                  <b>Contact governance</b>
                  <div style={{ marginTop: 5, fontSize: 13 }}>Service contact: {current.consent.service ? "allowed" : "disabled"} · Marketing: {current.consent.marketing ? "consented" : "suppressed"}</div>
                  {current.dataQuality.issues.length > 0 && <small style={{ display: "block", marginTop: 5 }}>Review: {current.dataQuality.issues.join(", ")}</small>}
                </div>
                <h3 style={{ color: forest }}>Maximum Revenue worklist</h3>
                {customerActions.length === 0 ? <p style={{ color: "#3D4A46" }}>No governed action for this customer.</p> : customerActions.map(a => {
                  let suppress: string[] = [];
                  try { suppress = JSON.parse(String(a.suppression_json || "[]")); } catch { /* ignore */ }
                  return (
                    <div key={a.id} style={{ ...card, padding: 13, marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <strong>{String(a.reason || "Revenue opportunity")}</strong>
                          <small style={{ display: "block", marginTop: 4 }}>score {Number(a.score || 0)} · estimate ₹{Number(a.expected_revenue || 0).toLocaleString("en-IN")} · {String(a.status || "")}</small>
                          {suppress.length > 0 && <small style={{ display: "block", color: "#9a5b00", marginTop: 4 }}>Suppressed: {suppress.join(", ")}</small>}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          {String(a.status) === "ready" && <button disabled={busy === a.id} onClick={() => revenue("claim", a.id)} style={{ background: forest, color: "#FFF8EE", border: 0, borderRadius: 8, padding: "8px 12px" }}>Claim</button>}
                          {String(a.status) === "claimed" && <button disabled={busy === a.id} onClick={() => revenue("complete", a.id)} style={{ background: gold, color: forest, border: 0, borderRadius: 8, padding: "8px 12px" }}>Complete</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </article>
        </section>
        <p style={{ fontSize: 12, color: "#3D4A46", marginTop: 12 }}>Legacy CRM screens may remain for comparison/UAT, but Team Sales now reads canonical Customer 360 and governed Revenue Intelligence.</p>
      </div>
    </main>
  );
}
