"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type MeetGreetRequest = {
  id: string;
  customerId: string;
  hostId: string;
  format: "phone_call" | "house_visit";
  status: "requested" | "confirmed" | "completed" | "cancelled" | "no_show";
  preferredAt: number;
  intendedStayDays: number;
  price: number;
  cancellationReason?: string;
  createdAt: number;
  updatedAt: number;
};

type MeetGreetEvent = {
  id: string;
  requestId: string;
  eventType: string;
  actor: string;
  notes?: string;
  createdAt: number;
};

const box = { background: "white", border: "1px solid #e4e4e4", borderRadius: 14, padding: 16 } as const;
const when = (v: number) => new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const formatLabel = (v: string) => v.replaceAll("_", " ").toUpperCase();

async function request(body?: Record<string, unknown>) {
  const response = await fetch("/api/meet-and-greet", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Meet-greet request failed");
  return payload;
}

async function fetchRequests(): Promise<MeetGreetRequest[]> {
  const payload = await request();
  return payload.data as MeetGreetRequest[];
}

async function fetchRequestWithEvents(requestId: string): Promise<{ request: MeetGreetRequest; events: MeetGreetEvent[] }> {
  const response = await fetch(`/api/meet-and-greet?requestId=${requestId}&events=true`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Unable to fetch request details");
  return { request: payload.data as MeetGreetRequest, events: (payload.data as any).events || [] };
}

export default function MeetGreetTeamPage() {
  const [requests, setRequests] = useState<MeetGreetRequest[]>([]);
  const [active, setActive] = useState<MeetGreetRequest | null>(null);
  const [events, setEvents] = useState<MeetGreetEvent[]>([]);
  const [filter, setFilter] = useState("requested");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    void fetchRequests()
      .then((data) => {
        if (!mounted) return;
        setRequests(data);
        const first = data.find((r) => r.status === "requested") || data[0];
        if (first) {
          setActive(first);
          void fetchRequestWithEvents(first.id).then(({ events: e }) => {
            if (mounted) setEvents(e);
          });
        }
      })
      .catch((problem) => {
        if (mounted) setError(problem instanceof Error ? problem.message : "Unable to load meet-greet requests");
      });
    return () => {
      mounted = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return requests;
    return requests.filter((r) => r.status === filter);
  }, [requests, filter]);

  async function act(action: string, data?: Record<string, unknown>) {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      const result = await request({ action, requestId: active.id, ...data });
      const updated = result.data as MeetGreetRequest;
      setActive(updated);
      setRequests((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      const details = await fetchRequestWithEvents(updated.id);
      setEvents(details.events);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to update request");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      const data = await fetchRequests();
      setRequests(data);
      if (active) {
        const details = await fetchRequestWithEvents(active.id);
        setActive(details.request);
        setEvents(details.events);
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to refresh");
    } finally {
      setBusy(false);
    }
  }

  const summary = {
    total: requests.length,
    requested: requests.filter((r) => r.status === "requested").length,
    confirmed: requests.filter((r) => r.status === "confirmed").length,
    completed: requests.filter((r) => r.status === "completed").length,
    cancelled: requests.filter((r) => r.status === "cancelled").length,
  };

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 28, fontFamily: "system-ui", display: "grid", gap: 16 }}>
      <header>
        <Link href="/team">Team</Link>
        <p>MEET & GREET · OPERATIONS QUEUE</p>
        <h1>Pre-booking host connection requests</h1>
        <p>Customers can request phone calls (always free) or house visits (₹499 or free for 5+ day stays). Staff confirms, completes, or marks no-show.</p>
      </header>

      {error && <p style={{ padding: 12, border: "1px solid currentColor", color: "red" }}>{error}</p>}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <article style={box}>
          <small>TOTAL</small>
          <strong style={{ display: "block", fontSize: 28 }}>{summary.total}</strong>
        </article>
        <article style={box}>
          <small>REQUESTED</small>
          <strong style={{ display: "block", fontSize: 28 }}>{summary.requested}</strong>
        </article>
        <article style={box}>
          <small>CONFIRMED</small>
          <strong style={{ display: "block", fontSize: 28 }}>{summary.confirmed}</strong>
        </article>
        <article style={box}>
          <small>COMPLETED</small>
          <strong style={{ display: "block", fontSize: 28 }}>{summary.completed}</strong>
        </article>
        <article style={box}>
          <small>CANCELLED</small>
          <strong style={{ display: "block", fontSize: 28 }}>{summary.cancelled}</strong>
        </article>
      </section>

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {["requested", "confirmed", "completed", "all"].map((status) => (
          <button key={status} onClick={() => setFilter(status)} disabled={filter === status} style={{ padding: "8px 16px" }}>
            {formatLabel(status)}
          </button>
        ))}
        <button onClick={() => void refresh()} style={{ padding: "8px 16px", marginLeft: "auto" }}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
        <aside style={box}>
          <h3 style={{ marginTop: 0 }}>Queue ({filtered.length})</h3>
          <div style={{ maxHeight: "600px", overflowY: "auto" }}>
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActive(item);
                  void fetchRequestWithEvents(item.id).then(({ events: e }) => setEvents(e));
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: 10,
                  marginBottom: 8,
                  border: active?.id === item.id ? "2px solid #1f7d56" : "1px solid #ddd",
                  borderRadius: 6,
                  background: active?.id === item.id ? "#f0fdf4" : "white",
                  cursor: "pointer",
                }}
              >
                <strong>{item.format === "phone_call" ? "📞" : "🏠"} {item.hostId}</strong>
                <br />
                <small>
                  {formatLabel(item.format)} · {formatLabel(item.status)}
                </small>
                <br />
                <small style={{ color: "#666" }}>{item.id}</small>
              </button>
            ))}
          </div>
        </aside>

        <article style={box}>
          {!active ? (
            <p>No request selected.</p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 16 }}>
                <div>
                  <h2 style={{ marginTop: 0, marginBottom: 4 }}>{active.id}</h2>
                  <small style={{ color: "#666" }}>
                    {formatLabel(active.format)} · {formatLabel(active.status)} · ₹{active.price} {active.price === 0 ? "(free)" : ""}
                  </small>
                </div>
                <code style={{ fontSize: 11, background: "#f5f5f5", padding: "4px 8px", borderRadius: 4 }}>{active.createdAt}</code>
              </div>

              <section style={{ marginBottom: 16, padding: 12, background: "#f9f9f9", borderRadius: 8 }}>
                <p style={{ margin: "4px 0" }}>
                  <b>Customer:</b> {active.customerId}
                </p>
                <p style={{ margin: "4px 0" }}>
                  <b>Host:</b> {active.hostId}
                </p>
                <p style={{ margin: "4px 0" }}>
                  <b>Preferred at:</b> {when(active.preferredAt)}
                </p>
                <p style={{ margin: "4px 0" }}>
                  <b>Intended stay:</b> {active.intendedStayDays} days
                </p>
                {active.cancellationReason && (
                  <p style={{ margin: "4px 0", color: "#d32f2f" }}>
                    <b>Cancellation reason:</b> {active.cancellationReason}
                  </p>
                )}
              </section>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                {active.status === "requested" && (
                  <>
                    <button disabled={busy} onClick={() => void act("confirm")}>
                      Confirm
                    </button>
                    <button disabled={busy} onClick={() => void act("cancel", { reason: "Host declined" })}>
                      Cancel
                    </button>
                  </>
                )}
                {active.status === "confirmed" && (
                  <>
                    <button disabled={busy} onClick={() => void act("complete")}>
                      Mark Completed
                    </button>
                    <button disabled={busy} onClick={() => void act("no_show")}>
                      Mark No-Show
                    </button>
                    <button disabled={busy} onClick={() => void act("cancel", { reason: "Customer request" })}>
                      Cancel
                    </button>
                  </>
                )}
                {["completed", "no_show", "cancelled"].includes(active.status) && (
                  <p style={{ fontSize: 12, color: "#666" }}>This request is in terminal status and cannot be modified.</p>
                )}
              </div>

              <section style={{ background: "#f9f9f9", borderRadius: 8, padding: 12, marginTop: 16 }}>
                <h4 style={{ marginTop: 0 }}>Timeline ({events.length} events)</h4>
                <div style={{ fontSize: 12, maxHeight: 300, overflowY: "auto" }}>
                  {events.map((event) => (
                    <div key={event.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e0e0e0" }}>
                      <strong>{formatLabel(event.eventType)}</strong> by <code>{event.actor}</code>
                      <br />
                      <small style={{ color: "#666" }}>{when(event.createdAt)}</small>
                      {event.notes && <p style={{ margin: "4px 0", color: "#666", fontSize: 11 }}>{event.notes}</p>}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </article>
      </section>
    </main>
  );
}
