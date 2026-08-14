"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type EmployeeRow = Record<string, unknown> & { employeeEmail: string; name: string };
type Dashboard = {
  asOf: number; today: string; scope: string; employeeCount: number;
  verticals: { sales: EmployeeRow[]; groomers: EmployeeRow[]; trainers: EmployeeRow[]; other: EmployeeRow[] };
  classificationBasis: Record<string, string>;
  note: string;
};

const card: React.CSSProperties = { border: "1px solid #dcece5", borderRadius: 14, padding: 18, background: "white", marginBottom: 16 };
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 12, color: "#1f6b57", fontWeight: 700, borderBottom: "2px solid #e9f1ee" };
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid #e9f1ee" };

export default function ManagerDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    fetch("/api/manager-dashboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => { if (p.error) throw new Error(p.error); setData(p.data); })
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 20px 64px", fontFamily: "system-ui,sans-serif", color: "#06231c" }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ fontWeight: 900, letterSpacing: 1.2, margin: 0, color: "#1f6b57" }}>PAWSPACE · PEOPLE</p>
        <h1 style={{ margin: "8px 0", fontSize: 30 }}>Manager / Founder dashboard</h1>
        <p style={{ maxWidth: 900, color: "#667571" }}>
          A real, complete company view before your meeting - only the people who actually report to you (managers), or everyone across every vertical (founders, People, Payroll, Audit).
          Every figure here is a live read from the same governed engines used for real pay. <Link href="/team/people">Back to People</Link>
        </p>
      </header>

      {error && <div style={{ ...card, background: "#fff3e0", borderColor: "#f0b429" }}>Could not load: {error}</div>}
      {!data && !error && <p>Loading…</p>}

      {data && (
        <>
          <section style={card}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div><small style={{ color: "#667571" }}>Scope</small><h3 style={{ margin: "4px 0", textTransform: "capitalize" }}>{data.scope === "all" ? "Everyone" : "Your direct reports"}</h3></div>
              <div><small style={{ color: "#667571" }}>Employees in view</small><h3 style={{ margin: "4px 0" }}>{data.employeeCount}</h3></div>
              <div><small style={{ color: "#667571" }}>As of</small><h3 style={{ margin: "4px 0" }}>{data.today}</h3></div>
            </div>
            <p style={{ fontSize: 12, color: "#667571", marginTop: 12, marginBottom: 0 }}>{data.note}</p>
          </section>

          {data.verticals.sales.length > 0 && (
            <section style={card}>
              <h2 style={{ marginTop: 0, fontSize: 16 }}>Sales / Telesales</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Name</th><th style={th}>Today&apos;s achievement</th><th style={th}>7-day total</th><th style={th}>Month achievement</th><th style={th}>Month target</th><th style={th}>Day closed?</th><th style={th}>Talk time today</th></tr></thead>
                <tbody>
                  {data.verticals.sales.map((row) => (
                    <tr key={row.employeeEmail}>
                      <td style={td}>{row.name}</td>
                      <td style={td}>{(row.daily as { achievedValue?: number } | null)?.achievedValue ?? "—"}</td>
                      <td style={td}>{(row.weekly as { achievedValue?: number })?.achievedValue ?? "—"}</td>
                      <td style={td}>{(row.monthly as { achievedValue?: number } | null)?.achievedValue ?? "—"}</td>
                      <td style={td}>{(row.monthly as { tierTarget?: number } | null)?.tierTarget ?? "—"}</td>
                      <td style={td}>{row.dayClosureReady === true ? "✅ Yes" : row.dayClosureReady === false ? "⚠ No" : "—"}</td>
                      <td style={td}>{(row.talkTimeMinutesToday as number | undefined) ?? "—"} min</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.verticals.groomers.length > 0 && (
            <section style={card}>
              <h2 style={{ marginTop: 0, fontSize: 16 }}>Groomer</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Name</th><th style={th}>Month orders</th><th style={th}>Month total</th><th style={th}>Target</th><th style={th}>Crossed target?</th><th style={th}>Head payout</th></tr></thead>
                <tbody>
                  {data.verticals.groomers.map((row) => (
                    <tr key={row.employeeEmail}>
                      <td style={td}>{row.name}</td>
                      <td style={td}>{(row.monthly as { orderCountTotal?: number } | null)?.orderCountTotal ?? "—"}</td>
                      <td style={td}>{(row.monthly as { monthTotal?: number } | null)?.monthTotal ?? "—"}</td>
                      <td style={td}>{(row.monthly as { targetAmount?: number } | null)?.targetAmount ?? "—"}</td>
                      <td style={td}>{(row.monthly as { crossedTarget?: boolean } | null)?.crossedTarget ? "✅" : "—"}</td>
                      <td style={td}>{(row.monthly as { headTotal?: number } | null)?.headTotal ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.verticals.trainers.length > 0 && (
            <section style={card}>
              <h2 style={{ marginTop: 0, fontSize: 16 }}>Trainer</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Name</th><th style={th}>Month order value</th><th style={th}>Revenue incentive</th><th style={th}>Meet &amp; Greet incentive</th><th style={th}>Total</th></tr></thead>
                <tbody>
                  {data.verticals.trainers.map((row) => (
                    <tr key={row.employeeEmail}>
                      <td style={td}>{row.name}</td>
                      <td style={td}>{(row.monthly as { orderValue?: number } | null)?.orderValue ?? "—"}</td>
                      <td style={td}>{(row.monthly as { revenueIncentive?: number } | null)?.revenueIncentive ?? "—"}</td>
                      <td style={td}>{(row.monthly as { meetGreetIncentive?: number } | null)?.meetGreetIncentive ?? "—"}</td>
                      <td style={td}>{(row.monthly as { total?: number } | null)?.total ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.verticals.other.length > 0 && (
            <section style={card}>
              <h2 style={{ marginTop: 0, fontSize: 16 }}>Other / not yet classified into a vertical</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Name</th><th style={th}>Title</th></tr></thead>
                <tbody>
                  {data.verticals.other.map((row) => (
                    <tr key={row.employeeEmail}><td style={td}>{row.name}</td><td style={td}>{String(row.title ?? "—")}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </main>
  );
}
