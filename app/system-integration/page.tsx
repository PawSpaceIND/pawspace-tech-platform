"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./page.module.css";

type Control = { id: string; label: string; status: string; evidence: string };
type Integration = { name: string; from: string; to: string; passed: boolean; detail?: string };
type Payload = { checkedAt: number; environment: string; schema: { ready: number; total: number }; credentials: Record<string, boolean>; controls: Control[]; integrations: Integration[]; summary: { internalPassed: number; internalTotal: number; externalReady: number; externalTotal: number; uatStatus: string; liveStatus: string }; latestRun?: { id: string; status: string; actor_email: string; created_at: number } | null };

const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
const when = (value: number) => new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function SystemIntegrationPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/system-integration", { cache: "no-store" })
      .then(async response => {
        const payload = await response.json() as Payload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load integration status");
        if (active) setData(payload);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load integration status"); });
    return () => { active = false; };
  }, []);
  async function confirm() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/system-integration", { method: "POST" });
      const payload = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Confirmation failed");
      setData(payload);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Confirmation failed"); }
    finally { setBusy(false); }
  }
  if (!data) return <main className={styles.loading}>{error || "Checking every PawSpace system connection…"}</main>;
  const internalDone = data.summary.internalPassed === data.summary.internalTotal;
  return <main className={styles.shell}>
    <aside className={styles.side}>
      <Link href="/control" className={styles.brand}><b>paw</b>space <span>CONTROL</span></Link>
      <nav><Link href="/team">⌂ Team</Link><Link href="/team/operations/bookings">▤ Booking Command Center</Link><Link href="/team/sales">⚡ Revenue & CX</Link><Link href="/control">◇ Launch essentials</Link><Link className={styles.active} href="/control/integrations">◎ System integration</Link></nav>
      <div className={styles.boundary}><b>UAT BOUNDARY</b><span>No live payments</span><span>No customer rollout</span><span>Vendor delivery stays locked until verified</span></div>
    </aside>
    <section className={styles.workspace}>
      <header className={styles.top}><div><span>PAWSPACE RELEASE CONTROL</span><h1>System Integration Control</h1><p>One evidence screen for every launch-essential workflow and external connection.</p></div><button disabled={busy} onClick={() => void confirm()}>{busy ? "Running…" : "Run full confirmation"}</button></header>
      <section className={styles.hero}>
        <div><small>INTERNAL UAT</small><strong>{data.summary.internalPassed}/{data.summary.internalTotal}</strong><span className={internalDone ? styles.good : styles.warn}>{pretty(data.summary.uatStatus)}</span><p>Canonical records, controls and management outputs</p></div>
        <div><small>EXTERNAL CONNECTIONS</small><strong>{data.summary.externalReady}/{data.summary.externalTotal}</strong><span className={data.summary.externalReady === data.summary.externalTotal ? styles.good : styles.blocked}>{pretty(data.summary.liveStatus)}</span><p>WATI, SMS, Exotel and production scheduler</p></div>
        <div><small>DATA MODEL</small><strong>{data.schema.ready}/{data.schema.total}</strong><span className={data.schema.ready === data.schema.total ? styles.good : styles.warn}>Persistent tables ready</span><p>Checked {when(data.checkedAt)}</p></div>
      </section>
      {error && <div className={styles.error}>{error}</div>}
      <section className={styles.panel}><header><div><span>SIX RELEASE ITEMS</span><h2>Closure status</h2></div><em>Evidence, not assumptions</em></header><div className={styles.controls}>{data.controls.map(item => <article key={item.id}><i className={item.status === "uat_closed" || item.status === "ready_for_live_test" ? styles.passDot : item.status === "external_setup_required" ? styles.blockDot : styles.warnDot}></i><div><h3>{item.label}</h3><p>{item.evidence}</p></div><b>{pretty(item.status)}</b></article>)}</div></section>
      <section className={styles.panel}><header><div><span>END-TO-END CONNECTIONS</span><h2>System chain confirmation</h2></div><em>{data.summary.internalPassed} passed</em></header><div className={styles.integrations}>{data.integrations.map(item => <article key={item.name}><div className={item.passed ? styles.passIcon : styles.failIcon}>{item.passed ? "✓" : "!"}</div><div><h3>{item.name}</h3><p>{item.from} <b>→</b> {item.to}</p></div><span>{item.detail || (item.passed ? "Connected" : "Action required")}</span></article>)}</div></section>
      <section className={styles.external}><div><span>LIVE VENDOR GATE</span><h2>What still needs Karthik’s vendor setup</h2><p>Internal UAT can be closed independently. Live delivery is confirmed only after credentials, approved templates, consent checks and webhook callbacks pass.</p></div><div>{Object.entries(data.credentials).map(([name, ready]) => <article key={name}><i className={ready ? styles.passDot : styles.blockDot}></i><b>{name === "telephony" ? "Exotel telephony" : pretty(name)}</b><span>{ready ? "Configured" : "Credentials required"}</span></article>)}</div></section>
      <footer><span>{data.latestRun ? `Latest signed confirmation: ${data.latestRun.id} · ${when(data.latestRun.created_at)}` : "No signed confirmation run yet"}</span><Link href="/control">Open Launch Essentials →</Link></footer>
    </section>
  </main>;
}
