"use client";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, StatCard } from "../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from "../team-console.module.css";

type MeetGreet = {
  id: string;
  customerId: string;
  hostProviderId: string;
  format: "phone" | "house_visit";
  intendedStayStart: string | null;
  intendedStayEnd: string | null;
  intendedStayDays: number;
  preferredAt: number;
  priceCharged: number;
  priceWaivedReason: string | null;
  status: "requested" | "confirmed" | "completed" | "cancelled" | "no_show";
  notes: string | null;
  createdAt: number;
};

const when = (value: number) => new Date(Number(value || 0)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0);
const words = (value: string) => value.replaceAll("_", " ");
const statusTone = (status: MeetGreet["status"]) =>
  status === "confirmed" ? "success" : status === "completed" ? "info" : status === "requested" ? "warning" : "neutral";

export default function MeetAndGreetPage() {
  const [rows, setRows] = useState<MeetGreet[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/meet-and-greet", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { data?: MeetGreet[]; error?: string };
      if (!response.ok || body.error) throw new Error(String(body.error || `Unable to load meet & greet requests (HTTP ${response.status})`));
      setRows((body.data ?? []) as MeetGreet[]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);

  const transition = async (requestId: string, action: string) => {
    setBusyId(requestId); setError("");
    try {
      const response = await fetch("/api/meet-and-greet", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, action }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(String(body.error || `Transition failed (HTTP ${response.status})`));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  };

  const open = rows.filter((row) => row.status === "requested");
  const houseVisits = rows.filter((row) => row.format === "house_visit").length;
  const waived = rows.filter((row) => row.priceWaivedReason).length;

  return <OpsShell
      eyebrow="Boarding & sitting · Meet & greet"
      title="Meet & greet requests"
      description="Pre-booking host meetings: free 10-minute phone calls, or 4-hour house visits at ₹499 — waived automatically for stays of 5 days or more. Sandbox/UAT: no live money moves here."
      actions={<Badge tone={open.length ? "warning" : "success"} dot>{open.length} awaiting a decision</Badge>}
      >

    {error ? <div className={`${styles.panel} ${styles.panelError}`} role="alert"><b>{error}</b></div> : null}

    <section className={styles.tiles}>
      <StatCard label="Requested" value={open.length} />
      <StatCard label="All requests" value={rows.length} />
      <StatCard label="House visits" value={houseVisits} meta={`${rows.length - houseVisits} phone`} />
      <StatCard label="Fee waived" value={waived} meta="5+ day stays" />
    </section>

    {loading ? <EmptyState title="Loading meet & greet requests" body="Reading the canonical request list…" />
      : rows.length === 0 ? <EmptyState title="No meet & greet requests yet" body="Requests appear here when a customer asks to meet a host before booking a stay — a free phone call, or a house visit." />
      : <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Request</th><th>Format · price</th><th>Preferred (IST)</th><th>Intended stay</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{rows.map((item) => <tr key={item.id}>
          <td><div className={styles.stack}>
            <b>{item.customerId} → {item.hostProviderId}</b>
            <small>{item.id}</small>
            <small>raised {when(item.createdAt)}</small>
          </div></td>
          <td><div className={styles.stack}>
            <span>{item.format === "phone" ? "Phone · 10 min" : "House visit · 4 h"}</span>
            <small>{item.priceCharged > 0 ? money(item.priceCharged) : item.priceWaivedReason ? `Free (${words(item.priceWaivedReason)})` : "Free"}</small>
          </div></td>
          <td><small>{when(item.preferredAt)}</small></td>
          <td><div className={styles.stack}>
            <span>{item.intendedStayDays} {item.intendedStayDays === 1 ? "day" : "days"}</span>
            {item.intendedStayStart ? <small>{item.intendedStayStart}{item.intendedStayEnd ? ` → ${item.intendedStayEnd}` : ""}</small> : null}
          </div></td>
          <td><Badge tone={statusTone(item.status)}>{words(item.status)}</Badge></td>
          <td><div className={styles.actions}>
            {item.status === "requested" ? <>
              <Button size="sm" disabled={busyId === item.id} onClick={() => { void transition(item.id, "confirm"); }}>Confirm</Button>
              <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => { void transition(item.id, "cancel"); }}>Cancel</Button>
            </> : null}
            {item.status === "confirmed" ? <>
              <Button size="sm" variant="secondary" disabled={busyId === item.id} onClick={() => { void transition(item.id, "complete"); }}>Mark completed</Button>
              <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => { void transition(item.id, "no_show"); }}>No show</Button>
            </> : null}
            {["completed", "cancelled", "no_show"].includes(item.status) ? <small>closed</small> : null}
          </div></td>
        </tr>)}</tbody>
      </table></div>}

    <footer className={styles.footnote}>Cancellations are always free — 100% refund, zero cancellation fee (platform-wide policy). <b>Sandbox/UAT:</b> no live money.</footer>
  </OpsShell>;
}
