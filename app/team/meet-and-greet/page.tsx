"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

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

const box = { background: "var(--ds-surface)", border: "1px solid var(--ds-border)", borderRadius: "var(--ds-radius-lg)", padding: 16 } as const;
const row = { display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1.4fr", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--ds-border)", fontSize: 14 } as const;
const when = (ms: number) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const NEXT_ACTIONS: Record<string, Array<{ action: string; label: string }>> = {
  requested: [
    { action: "confirm", label: "Confirm" },
    { action: "cancel", label: "Cancel" },
  ],
  confirmed: [
    { action: "complete", label: "Complete" },
    { action: "no_show", label: "No-show" },
    { action: "cancel", label: "Cancel" },
  ],
};

export default function TeamMeetGreetQueue() {
  const [rows, setRows] = useState<MeetGreet[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  const load = () =>
    fetch("/api/meet-and-greet", { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => {
        if (body.error) setError(String(body.error));
        else {
          setError("");
          setRows((body.data ?? []) as MeetGreet[]);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load meet & greet requests"))
      .finally(() => setLoading(false));

  useEffect(() => {
    let live = true;
    fetch("/api/meet-and-greet", { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => {
        if (!live) return;
        if (body.error) setError(String(body.error));
        else setRows((body.data ?? []) as MeetGreet[]);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Unable to load meet & greet requests");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const transition = async (requestId: string, action: string) => {
    setBusyId(requestId);
    setError("");
    try {
      const response = await fetch("/api/meet-and-greet", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, action }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(String(body.error || "Transition failed"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transition failed");
    } finally {
      setBusyId("");
    }
  };

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 28, fontFamily: "system-ui", display: "grid", gap: 16 }}>
      <header>
        <Link href="/team">← Team</Link>
        <p style={{ color: "var(--ds-primary-500)", letterSpacing: 1, fontSize: 12 }}>BOARDING &amp; SITTING · MEET &amp; GREET</p>
        <h1 style={{ margin: 0 }}>Meet &amp; greet requests</h1>
        <p>Pre-booking host meetings: free 10-minute phone calls, or 4-hour house visits (₹499, waived for 5+ day stays). Newest first. Sandbox/UAT — no live money.</p>
      </header>
      {error && (
        <p role="alert" style={{ color: "var(--ds-danger-500)" }}>
          {error}
        </p>
      )}
      <section style={box}>
        <div style={{ ...row, fontWeight: 700, color: "var(--ds-text-muted)" }}>
          <span>Request</span>
          <span>Format · Price</span>
          <span>Preferred (IST)</span>
          <span>Intended stay</span>
          <span>Status · Actions</span>
        </div>
        {loading && <p>Loading…</p>}
        {!loading && rows.length === 0 && <p>No meet &amp; greet requests yet.</p>}
        {rows.map((item) => (
          <div key={item.id} style={row}>
            <span>
              {item.customerId} → {item.hostProviderId}
              <br />
              <small>{item.id} · {when(item.createdAt)}</small>
              {item.notes ? (
                <>
                  <br />
                  <small>{item.notes}</small>
                </>
              ) : null}
            </span>
            <span>
              {item.format === "phone" ? "Phone · 10 min" : "House visit · 4 h"}
              <br />
              <small>
                {item.priceCharged === 0 ? "FREE" : `₹${item.priceCharged}`}
                {item.priceWaivedReason === "stay_5_days_or_more" ? " (5+ day stay)" : ""}
              </small>
            </span>
            <span>{when(item.preferredAt)}</span>
            <span>
              {item.intendedStayDays} day{item.intendedStayDays === 1 ? "" : "s"}
              {item.intendedStayStart ? (
                <>
                  <br />
                  <small>
                    {item.intendedStayStart} → {item.intendedStayEnd || "?"}
                  </small>
                </>
              ) : null}
            </span>
            <span>
              <b style={{ textTransform: "capitalize" }}>{item.status.replaceAll("_", " ")}</b>
              <br />
              {(NEXT_ACTIONS[item.status] || []).map(({ action, label }) => (
                <button
                  key={action}
                  disabled={busyId === item.id}
                  onClick={() => void transition(item.id, action)}
                  style={{ marginRight: 6, marginTop: 4 }}
                >
                  {busyId === item.id ? "…" : label}
                </button>
              ))}
            </span>
          </div>
        ))}
      </section>
      <footer>
        <small>Cancellations are always free — 100% refund, zero cancellation fee (platform-wide policy).</small>
      </footer>
    </main>
  );
}
