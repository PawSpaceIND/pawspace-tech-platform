"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./whatsapp-inbox.module.css";

type Row = Record<string, unknown>;
type Thread = Row & { id: string; customer_name?: string; customer_id?: string; primary_phone?: string; lead_id?: string; assigned_to?: string; lastMessage?: Row | null };
type Conversation = { thread: Row; participants: Row[]; messages: Array<Row & { payload?: Row }>; assignments: Row[] };
type RoutingMode = "human_only" | "chatbot_only" | "ai_assistant";
type Control = { provider?: string; routing?: { mode?: RoutingMode }; handoff?: { aiPaused?: boolean; current?: Row | null }; canHumanReply?: boolean };

const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const pretty = (value: unknown) => text(value).replaceAll("_", " ");
const initials = (value: unknown) => text(value, "PS").split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase();
const when = (value: unknown) => value ? new Date(Number(value)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
const dateTime = (value: unknown) => value ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";

export default function CustomerExperiencePage() {
  const [mounted, setMounted] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);

  useEffect(() => setMounted(true), []);

  async function loadThreads() {
    const response = await fetch("/api/conversations?status=open", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { data?: { threads?: Thread[] }; error?: string };
    if (!response.ok) throw new Error(body.error || `Unable to load conversations (${response.status})`);
    const rows = body.data?.threads || [];
    setThreads(rows);
    setSelected(current => current || rows[0]?.id || "");
  }

  async function loadSelected(id: string) {
    if (!id) return;
    const [conversationResponse, controlResponse] = await Promise.all([
      fetch(`/api/conversations?threadId=${encodeURIComponent(id)}`, { cache: "no-store" }),
      fetch(`/api/whatsapp/conversation-control?threadId=${encodeURIComponent(id)}`, { cache: "no-store" }),
    ]);
    const conversationBody = await conversationResponse.json().catch(() => ({})) as { data?: Conversation; error?: string };
    if (!conversationResponse.ok) throw new Error(conversationBody.error || `Unable to load conversation (${conversationResponse.status})`);
    setConversation(conversationBody.data || null);
    if (controlResponse.status === 404 || controlResponse.status === 409) setControl(null);
    else {
      const controlBody = await controlResponse.json().catch(() => ({})) as { data?: Control; error?: string };
      if (!controlResponse.ok) throw new Error(controlBody.error || `Unable to load WhatsApp controls (${controlResponse.status})`);
      setControl(controlBody.data || null);
    }
    setCheckedAt(Date.now());
  }

  useEffect(() => {
    if (!mounted) return;
    let active = true;
    const refresh = async () => {
      try { await loadThreads(); if (active) setError(""); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !selected) return;
    let active = true;
    const refresh = async () => {
      try { await loadSelected(selected); if (active) setError(""); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [mounted, selected]);

  async function controlAction(action: string, payload: Row = {}) {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/whatsapp/conversation-control", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, threadId: selected, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Action failed (${response.status})`);
      await Promise.all([loadThreads(), loadSelected(selected)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function sendReply() {
    const message = reply.trim();
    if (!message) return;
    const clientRequestId = crypto.randomUUID();
    await controlAction("human_reply", { message, clientRequestId });
    setReply("");
    setNotice("Reply queued through the governed WhatsApp outbox.");
  }

  const visible = useMemo(() => threads.filter(row => {
    const hay = `${text(row.customer_name, "")} ${text(row.customer_id, "")} ${text(row.primary_phone, "")} ${text(row.lastMessage?.channel, "")}`.toLowerCase();
    if (!hay.includes(query.toLowerCase())) return false;
    if (filter === "whatsapp") return text(row.lastMessage?.channel, "") === "whatsapp";
    if (filter === "unassigned") return !text(row.assigned_to, "");
    if (filter === "human") return Boolean(text(row.assigned_to, "")) && text(row.assigned_to, "") !== "ai-orchestrator";
    return true;
  }), [threads, query, filter]);

  if (!mounted) return <main style={{ padding: 32, fontFamily: "Arial,sans-serif" }}>Loading PawSpace Shared Inbox…</main>;

  const thread = conversation?.thread || null;
  const messages = conversation?.messages || [];
  const customerName = text(thread?.customer_name || thread?.customer_id, "Customer");
  const lastInbound = [...messages].reverse().find(message => text(message.direction, "") === "inbound");
  const withinWindow = Boolean(lastInbound && checkedAt && checkedAt - Number(lastInbound.created_at || 0) <= 24 * 60 * 60_000);
  const mode = control?.routing?.mode || "human_only";
  const humanMode = mode === "human_only";
  const aiMode = mode === "ai_assistant";
  const isWhatsApp = Boolean(control);
  const canReply = Boolean(isWhatsApp && humanMode && control?.canHumanReply && withinWindow && reply.trim() && !busy);

  return (
    <main style={{ padding: 18, background: "#f4f6f8", minHeight: "100vh", fontFamily: "Arial,sans-serif" }}>
      <div style={{ maxWidth: 1540, margin: "0 auto 14px", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
        <div><h1 style={{ margin: 0, fontSize: 24 }}>PawSpace WhatsApp AI Shared Inbox</h1><p style={{ margin: "5px 0 0", color: "#64748b" }}>WATI-style customer operations · staging/UAT</p></div>
        <div style={{ display: "flex", gap: 8 }}><span style={{ background: "#e8f5e9", padding: "7px 10px", borderRadius: 999, fontSize: 12 }}>UAT sandbox</span><span style={{ background: "#fff3cd", padding: "7px 10px", borderRadius: 999, fontSize: 12 }}>Production delivery disabled</span></div>
      </div>
      {error ? <div style={{ maxWidth: 1540, margin: "0 auto 10px", padding: 10, background: "#fee2e2", borderRadius: 10 }}><b>{error}</b></div> : null}
      {notice ? <div style={{ maxWidth: 1540, margin: "0 auto 10px", padding: 10, background: "#dcfce7", borderRadius: 10 }}><b>{notice}</b></div> : null}
      <div className={styles.shell} style={{ maxWidth: 1540, margin: "0 auto", minHeight: "calc(100vh - 120px)" }}>
        <aside className={styles.rail}>
          <div className={styles.brand}><div className={styles.brandMark}>PS</div><div><strong>PawSpace</strong><small>WhatsApp AI Ops</small></div></div>
          <nav className={styles.nav}>
            <div className={`${styles.navItem} ${styles.navActive}`}><span>Inbox</span><span className={styles.navCount}>{threads.length}</span></div>
            <div className={styles.navItem}><span>Leads</span><span>{threads.filter(row => row.lead_id).length}</span></div>
            <div className={styles.navItem}><span>Customers</span></div>
            <div className={styles.navItem}><span>Templates</span></div>
            <div className={styles.navItem}><span>AI Handoffs</span></div>
            <div className={styles.navItem}><span>Automation</span></div>
            <div className={styles.navItem}><span>Analytics</span></div>
          </nav>
          <div className={styles.connection}><span className={styles.dot}/>WhatsApp UAT connection<br/><b>Governed sandbox</b></div>
        </aside>

        <aside className={styles.list}>
          <div className={styles.listTop}><h2>Shared Inbox</h2><input className={styles.search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations…"/>
            <div className={styles.filters}>{[["all","All"],["whatsapp","WhatsApp"],["unassigned","Unassigned"],["human","Human"]].map(([key,label]) => <button key={key} className={`${styles.filter} ${filter === key ? styles.filterActive : ""}`} onClick={() => setFilter(key)}>{label}</button>)}</div>
          </div>
          <div className={styles.rows}>{visible.length ? visible.map(row => <button key={row.id} className={styles.row} aria-current={selected === row.id ? "true" : undefined} onClick={() => setSelected(row.id)}>
            <div className={styles.rowTop}><strong>{text(row.customer_name || row.customer_id, "Customer")}</strong><small>{when(row.lastMessage?.created_at || row.updated_at)}</small></div>
            <small>{pretty(row.lastMessage?.channel || "conversation")} · {text(row.lead_id, "canonical customer")}</small>
            <small>{text((row.lastMessage?.payload as Row | undefined)?.text || row.lastMessage?.template_key, "No message preview")}</small>
          </button>) : <div className={styles.empty}>No conversations match this view.</div>}</div>
        </aside>

        <section className={styles.chat}>
          {!thread ? <div className={styles.empty}>Select a conversation from the Shared Inbox.</div> : <>
            <header className={styles.chatHead}><div className={styles.person}><div className={styles.avatar}>{initials(customerName)}</div><div><h2>{customerName}</h2><small>{text(thread.lead_id, "Canonical customer")} · {isWhatsApp ? pretty(mode) : "conversation"}</small></div></div><span className={styles.window}>{isWhatsApp ? (withinWindow ? "WhatsApp window open" : "Template required") : "Canonical conversation"}</span></header>
            <div className={styles.aiBar}><div><b>{humanMode ? "Human only" : aiMode ? "AI Assistant" : "Chatbot only"}</b><br/><span>{humanMode ? "AI is blocked while a human owns this thread." : aiMode ? "AI may qualify the enquiry; governed actions remain protected." : "Deterministic chatbot routing."}</span></div><button className={styles.takeover} disabled={!isWhatsApp || busy} onClick={() => void controlAction("take_over", { reason: "CX operator takeover" })}>Take over</button></div>
            <div className={styles.messages}>{messages.length ? messages.map(message => <div key={text(message.id)} className={`${styles.bubble} ${text(message.direction, "") === "outbound" ? styles.bubbleOut : ""}`}><small>{pretty(message.direction)} · {pretty(message.channel)} · {pretty(message.status)}</small><p>{text(message.payload?.text || message.payload?.message || message.template_key, "Message")}</p><small>{dateTime(message.created_at)}</small></div>) : <div className={styles.empty}>No messages yet.</div>}</div>
            <div className={styles.notice}>AI may make mistakes. Price, availability, payment, cancellation and provider actions remain governed.</div>
            <footer className={styles.composer}><input value={reply} onChange={event => setReply(event.target.value)} disabled={!isWhatsApp || !humanMode || !withinWindow || busy} placeholder={!isWhatsApp ? "Select a WhatsApp thread" : !humanMode ? "Take over or switch to Human only" : !withinWindow ? "24-hour window closed" : "Reply as PawSpace CX…"}/><button className={styles.send} disabled={!canReply} onClick={() => void sendReply()}>Send</button></footer>
          </>}
        </section>

        <aside className={styles.inspector}>
          <section className={styles.card}><div className={styles.cardHead}><strong>Lead / Customer</strong><a>Canonical</a></div><div className={styles.kv}><span>Name</span><b>{customerName}</b><span>Phone</span><b>{text(thread?.primary_phone, "Masked by role")}</b><span>Lead</span><b>{text(thread?.lead_id, "Not lead-linked")}</b><span>Thread</span><b>{text(thread?.id)}</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Conversation Routing</strong><a>{pretty(mode)}</a></div><div className={styles.actions}><button className={`${styles.action} ${humanMode ? styles.actionPrimary : ""}`} disabled={!isWhatsApp || busy} onClick={() => void controlAction("set_mode", { mode: "human_only", reason: "CX routing decision" })}>Human only</button><button className={`${styles.action} ${aiMode ? styles.actionGreen : ""}`} disabled={!isWhatsApp || busy} onClick={() => void controlAction(control?.handoff?.aiPaused ? "resume_ai" : "set_mode", control?.handoff?.aiPaused ? { reason: "Resume AI" } : { mode: "ai_assistant", reason: "CX routing decision" })}>AI Assistant</button></div><div className={styles.kv} style={{ marginTop: 10 }}><span>Provider</span><b>{text(control?.provider, isWhatsApp ? "sandbox simulator" : "—")}</b><span>AI paused</span><b>{control?.handoff?.aiPaused ? "Yes" : "No"}</b><span>Production</span><b>Disabled</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Handoff Controls</strong><a>Governed</a></div><div className={styles.actions}><button className={`${styles.action} ${styles.actionPrimary}`} disabled={!isWhatsApp || busy} onClick={() => void controlAction("take_over", { reason: "CX operator takeover" })}>Take over</button><button className={styles.action} disabled={!isWhatsApp || !control?.handoff?.aiPaused || busy} onClick={() => void controlAction("resume_ai", { reason: "Resume AI" })}>Resume AI</button></div></section>
        </aside>
      </div>
    </main>
  );
}
