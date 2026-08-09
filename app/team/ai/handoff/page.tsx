"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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

type Handoff = {
  current?: HandoffCurrent | null;
  events?: Record<string, unknown>[];
  aiPaused?: boolean;
  sameCanonicalThread?: boolean;
};

const box = {
  background: "white",
  border: "1px solid #e5dcef",
  borderRadius: 14,
};

const label = (value: unknown) => String(value || "—").replaceAll("_", " ");

export default function AiHandoffPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadThreads = useCallback(async () => {
    const response = await fetch("/api/conversations?status=open", { cache: "no-store" });
    const body = (await response.json()) as { data?: { threads: Thread[] }; error?: string };
    if (!response.ok) throw new Error(body.error || "Unable to load conversations");
    const rows = body.data?.threads || [];
    setThreads(rows);
    return rows;
  }, []);

  const loadHandoff = useCallback(async (thread: Thread) => {
    if (!thread.customer_id) {
      setHandoff(null);
      return;
    }
    const response = await fetch(
      `/api/ai-human-handoff?threadId=${encodeURIComponent(thread.id)}&customerId=${encodeURIComponent(thread.customer_id)}`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as { data?: Handoff; error?: string };
    if (!response.ok) throw new Error(body.error || "Unable to load handoff");
    setHandoff(body.data || null);
  }, []);

  useEffect(() => {
    void loadThreads()
      .then((rows) => {
        if (rows[0]) setSelected(rows[0]);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load conversations"));
  }, [loadThreads]);

  useEffect(() => {
    if (!selected) return;
    void loadHandoff(selected).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Unable to load handoff"),
    );
  }, [selected, loadHandoff]);

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
      await Promise.all([loadThreads(), loadHandoff(selected)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Handoff action failed");
    } finally {
      setBusy(false);
    }
  }

  const current = handoff?.current || null;
  const transcript = Array.isArray(current?.summary?.transcript) ? current.summary.transcript : [];

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f7f4fb",
        padding: 28,
        fontFamily: "Arial, sans-serif",
        color: "#24133f",
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
            <small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · AI GATE 4</small>
            <h1 style={{ margin: "6px 0" }}>Human handoff & staff takeover</h1>
            <p style={{ margin: 0, color: "#756c7d" }}>
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
              background: "#fff1f1",
              border: "1px solid #efc2c2",
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
          }}
        >
          <aside style={{ ...box, overflow: "hidden" }}>
            <div style={{ padding: 16, borderBottom: "1px solid #eee6f5" }}>
              <b>Open canonical threads</b>
            </div>
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
                  borderBottom: "1px solid #f0ebf4",
                  background: selected?.id === thread.id ? "#f2ebfa" : "white",
                }}
              >
                <strong>{thread.customer_name || thread.customer_id || "Customer"}</strong>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {label(thread.assigned_to)} · {label(thread.status)}
                </div>
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

                <hr style={{ border: 0, borderTop: "1px solid #eee6f5", margin: "18px 0" }} />

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
                      <p style={{ color: "#756c7d" }}>No transcript excerpt captured.</p>
                    ) : (
                      transcript.map((message, index) => (
                        <div
                          key={index}
                          style={{ padding: 10, marginBottom: 8, background: "#f6f5f7", borderRadius: 10 }}
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
    </main>
  );
}
