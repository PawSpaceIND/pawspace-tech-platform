"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import StaffModule from "../../../components/staff-workspace/StaffModule";

type Thread = {
  id: string;
  customer_id?: string;
  customer_name?: string;
  assigned_to?: string;
  status?: string;
  sla_due_at?: number;
};

type TranscriptMessage = {
  direction?: unknown;
  channel?: unknown;
  text?: unknown;
};

type HandoffCurrent = Record<string, unknown> & {
  id?: string;
  status?: string;
  reason?: string;
  queue_code?: string;
  confidence?: number | null;
  summary?: { transcript?: TranscriptMessage[] };
};

type QueueEntry = {
  threadId: string;
  customerId: string;
  customerName?: string | null;
  customerPhone?: string | null;
  identitySource?: string;
  reason: string;
  queueCode: string;
  status: string;
  createdAt: number;
};

type Handoff = {
  current?: HandoffCurrent | null;
  events?: Record<string, unknown>[];
  aiPaused?: boolean;
  sameCanonicalThread?: boolean;
};

const box = {
  background: "var(--staff-surface)",
  border: "1px solid var(--staff-line)",
  borderRadius: 14,
};

const label = (value: unknown) => String(value || "—").replaceAll("_", " ");

/** The live escalation queue. Without it this page opened on whichever conversation sorted first —
 *  almost never one with a handoff — and reported "no handoff is active or recorded for this
 *  thread" while real escalations sat waiting. */
async function fetchQueue(): Promise<QueueEntry[]> {
  const response = await fetch("/api/ai-human-handoff?mode=queue", { cache: "no-store" });
  const body = (await response.json()) as { data?: { queue: QueueEntry[] }; error?: string };
  if (!response.ok) throw new Error(body.error || "Unable to load the AI handoff queue");
  return body.data?.queue || [];
}

async function fetchThreads(): Promise<Thread[]> {
  const response = await fetch("/api/conversations?status=open", { cache: "no-store" });
  const body = (await response.json()) as { data?: { threads: Thread[] }; error?: string };
  if (!response.ok) throw new Error(body.error || "Unable to load conversations");
  return body.data?.threads || [];
}

async function fetchHandoff(thread: Thread): Promise<Handoff | null> {
  if (!thread.customer_id) return null;
  const response = await fetch(
    `/api/ai-human-handoff?threadId=${encodeURIComponent(thread.id)}&customerId=${encodeURIComponent(thread.customer_id)}`,
    { cache: "no-store" },
  );
  const body = (await response.json()) as { data?: Handoff; error?: string };
  if (!response.ok) throw new Error(body.error || "Unable to load handoff");
  return body.data || null;
}

export default function AiHandoffPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchThreads(), fetchQueue().catch(() => [] as QueueEntry[])])
      .then(([rows, escalations]) => {
        if (cancelled) return;
        setThreads(rows);
        setQueue(escalations);
        // Open on a conversation that actually has a live handoff; fall back to the first thread only
        // when nothing is escalated.
        const escalated = rows.find((thread) => escalations.some((entry) => entry.threadId === thread.id));
        setSelected((current) => current || escalated || rows[0] || null);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load conversations");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void fetchHandoff(selected)
      .then((nextHandoff) => {
        if (!cancelled) setHandoff(nextHandoff);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load handoff");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function act(action: "take_over" | "resume_ai") {
    if (!selected?.customer_id) return;
    setBusy(true);
    setError("");
    try {
      const reason =
        action === "take_over"
          ? "Staff accepted AI escalation"
          : "Staff reviewed the thread and explicitly returned it to AI";
      const response = await fetch("/api/ai-human-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          threadId: selected.id,
          customerId: selected.customer_id,
          reason,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Handoff action failed");

      const [rows, nextHandoff] = await Promise.all([fetchThreads(), fetchHandoff(selected)]);
      setThreads(rows);
      setHandoff(nextHandoff);
      const refreshedSelected = rows.find((thread) => thread.id === selected.id);
      if (refreshedSelected) setSelected(refreshedSelected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Handoff action failed");
    } finally {
      setBusy(false);
    }
  }

  const current = handoff?.current || null;
  const transcript = Array.isArray(current?.summary?.transcript) ? current.summary.transcript : [];

  return (
    <StaffModule><main
      style={{
        minHeight: "100vh",
        background: "var(--staff-bg)",
        padding: 28,
        fontFamily: "inherit",
        color: "var(--staff-text)",
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            marginBottom: 20,
          }}
        >
          <div>
            <small style={{ fontWeight: 800, color: "var(--staff-primary)" }}>PAWSPACE TEAM · AI GATE 4</small>
            <h1 style={{ margin: "6px 0" }}>Human handoff & staff takeover</h1>
            <p style={{ margin: 0, color: "var(--staff-muted)" }}>
              AI pauses during staff ownership. Return to AI requires an explicit governed staff action.
            </p>
          </div>
          <Link href="/team/customer-experience" style={{ padding: 10, textDecoration: "none", ...box }}>
            CX workspace
          </Link>
        </header>

        {error && (
          <div
            style={{
              padding: 12,
              marginBottom: 14,
              background: "var(--staff-danger-bg)",
              border: "1px solid var(--staff-line)",
              borderRadius: 10,
            }}
          >
            {error}
          </div>
        )}

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(320px,.8fr) minmax(540px,1.4fr)",
            gap: 16,
          }} data-staff-grid="split"
        >
          <aside style={{ ...box, overflow: "hidden" }}>
            <div style={{ padding: 16, borderBottom: "1px solid var(--staff-line)" }}>
              <b>Open canonical threads</b>
              <div style={{ fontSize: 14, color: "var(--staff-muted)", marginTop: 4 }}>
                {queue.length === 0
                  ? "No conversation is currently escalated to a human."
                  : `${queue.filter((entry) => entry.status === "queued").length} waiting · ${queue.filter((entry) => entry.status === "staff_active").length} with staff`}
              </div>
            </div>
            {
              /* Every escalation, named, and reachable.
               *
               * The queue used to be read ONLY to badge a thread already in the list below, so a
               * customer whose thread is not in the open-conversations list - closed, or simply past
               * the list's limit - counted towards "waiting" with no row to click and no name to read.
               * Staff saw that somebody needed them and could not find out who. Selecting a row here
               * opens that thread directly, whether or not it is in the list below. */
              queue.length > 0 && (
                <div style={{ borderBottom: "1px solid var(--staff-line)", background: "var(--staff-warning-bg)" }}>
                  <div style={{ padding: "12px 16px 4px", fontSize: 14, fontWeight: 700, color: "var(--staff-warning)", textTransform: "uppercase", letterSpacing: ".06em" }}>Escalated to a human</div>
                  {queue.map((entry) => (
                    <button
                      key={entry.threadId}
                      onClick={() => setSelected({ id: entry.threadId, customer_id: entry.customerId, customer_name: entry.customerName || undefined })}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 16px", border: 0, background: selected?.id === entry.threadId ? "var(--staff-raised)" : "transparent" }}
                    >
                      <strong>{entry.customerName || entry.customerId || "Customer"}</strong>
                      <div style={{ fontSize: 14, color: "var(--staff-muted)", marginTop: 2 }}>
                        {/* The id stays visible beside the name: staff match it against CRM and Customer 360. */}
                        {entry.customerId}
                        {entry.customerPhone ? ` · ${entry.customerPhone}` : ""}
                      </div>
                      <div style={{ fontSize: 14, marginTop: 2 }}>
                        {entry.status === "queued" ? "Waiting for staff" : "With staff"} · {label(entry.reason)}
                        {/* Never present a CRM contact's name as the canonical identity, or the absence
                          * of one as if the customer were nameless. */}
                        {entry.identitySource === "crm_contact" ? " · CRM contact record" : entry.identitySource === "unresolved" ? " · no customer record found" : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )
            }
            {threads.length === 0 && <p style={{ padding: 16, color: "var(--staff-muted)" }}>No open conversations.</p>}
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => setSelected(thread)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: 14,
                  border: 0,
                  borderBottom: "1px solid var(--staff-line)",
                  background: selected?.id === thread.id ? "var(--staff-raised)" : "var(--staff-surface)",
                }}
              >
                <strong>{thread.customer_name || thread.customer_id || "Customer"}</strong>
                <div style={{ fontSize: 14, marginTop: 4 }}>
                  {label(thread.assigned_to)} · {label(thread.status)}
                </div>
                {(() => {
                  // Show at a glance which conversations the AI has escalated, so staff do not have
                  // to click every thread to find the ones that need them.
                  const entry = queue.find((item) => item.threadId === thread.id);
                  if (!entry) return null;
                  const waiting = entry.status === "queued";
                  return <span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", borderRadius: 999, fontSize: 14, fontWeight: 700, background: waiting ? "var(--staff-warning-bg)" : "var(--staff-success-bg)", color: waiting ? "var(--staff-warning)" : "var(--staff-success)" }}>{waiting ? "Waiting for staff" : "With staff"} · {label(entry.reason)}</span>;
                })()}
              </button>
            ))}
          </aside>

          <article style={{ ...box, padding: 20, minHeight: 560 }}>
            {!selected ? (
              <p>Select a thread.</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <small>{selected.id}</small>
                    <h2 style={{ margin: "5px 0" }}>{selected.customer_name || selected.customer_id}</h2>
                    <p style={{ margin: 0 }}>
                      Assignment: <b>{label(selected.assigned_to)}</b>
                    </p>
                  </div>
                  <div>
                    <b>{handoff?.aiPaused ? "AI paused" : "AI available"}</b>
                  </div>
                </div>

                <hr style={{ border: 0, borderTop: "1px solid var(--staff-line)", margin: "18px 0" }} />

                {!current ? (
                  <p>No Gate-4 handoff is active or recorded for this thread.</p>
                ) : (
                  <>
                    <p>
                      <b>Status:</b> {label(current.status)} · <b>Reason:</b> {label(current.reason)} ·{" "}
                      <b>Queue:</b> {label(current.queue_code)}
                    </p>
                    <p>
                      <b>Confidence:</b> {current.confidence == null ? "—" : String(current.confidence)}
                    </p>
                    <div style={{ display: "flex", gap: 8, margin: "14px 0" }}>
                      <button
                        disabled={busy || String(current.status) !== "queued"}
                        onClick={() => act("take_over")}
                      >
                        Take over
                      </button>
                      <button
                        disabled={busy || String(current.status) !== "staff_active"}
                        onClick={() => act("resume_ai")}
                      >
                        Return to AI
                      </button>
                    </div>
                    <h3>Handoff transcript summary</h3>
                    {transcript.length === 0 ? (
                      <p style={{ color: "var(--staff-muted)" }}>No transcript excerpt captured.</p>
                    ) : (
                      transcript.map((message, index) => (
                        <div
                          key={index}
                          style={{ padding: 10, marginBottom: 8, background: "var(--staff-raised)", borderRadius: 10 }}
                        >
                          <small>
                            {label(message.direction)} · {label(message.channel)}
                          </small>
                          <div>{String(message.text || "")}</div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </>
            )}
          </article>
        </section>
      </div>
    </main></StaffModule>
  );
}
