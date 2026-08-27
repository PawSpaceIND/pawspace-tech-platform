"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState } from "../../components/ui";
import OpsShell from "../../components/ops-shell/OpsShell";
import teamStyles from "../team-console.module.css";
import styles from "./whatsapp-inbox.module.css";

type Row = Record<string, unknown>;
type Thread = Row & {
  id: string;
  customer_name?: string;
  customer_id?: string;
  primary_phone?: string;
  lead_id?: string;
  status?: string;
  assigned_to?: string;
  lastMessage?: Row | null;
  ticket?: Row | null;
};
type Conversation = {
  thread: Row;
  participants: Row[];
  messages: Array<Row & { payload?: Row }>;
  assignments: Row[];
};
type RoutingMode = "human_only" | "chatbot_only" | "ai_assistant";
type WhatsAppControl = {
  threadId?: string;
  customerId?: string;
  provider?: string;
  routing?: { mode?: RoutingMode; explicit?: boolean; updatedBy?: string | null; reason?: string; updatedAt?: number | null };
  handoff?: { aiPaused?: boolean; current?: Row | null; events?: Row[] };
  canHumanReply?: boolean;
  chatbotReady?: boolean;
  productionDelivery?: boolean;
  environment?: string;
};

const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const pretty = (value: unknown) => text(value).replaceAll("_", " ");
const when = (value: unknown) => value
  ? new Date(Number(value)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })
  : "";
const dateTime = (value: unknown) => value
  ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
  : "—";
const initials = (name: unknown) => text(name, "PS").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

export default function CustomerExperiencePage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [control, setControl] = useState<WhatsAppControl | null>(null);
  const [serviceWindowCheckedAt, setServiceWindowCheckedAt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [reply, setReply] = useState("");
  const [replyRequestId, setReplyRequestId] = useState("");
  const [routingReason, setRoutingReason] = useState("CX operator routing decision");

  const loadThreads = useCallback(async () => {
    const response = await fetch("/api/conversations?status=open", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: { threads: Thread[] }; error?: string };
    if (!response.ok) throw new Error(payload.error || `Unable to load conversations (HTTP ${response.status})`);
    const next = payload.data?.threads || [];
    setThreads(next);
    return next;
  }, []);

  const loadConversation = useCallback(async (id: string, shouldApply: () => boolean = () => true) => {
    if (!id) return;
    const response = await fetch(`/api/conversations?threadId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: Conversation; error?: string };
    if (!response.ok) throw new Error(payload.error || `Unable to load conversation (HTTP ${response.status})`);
    if (!shouldApply()) return;
    setConversation(payload.data || null);
    setServiceWindowCheckedAt(Date.now());
  }, []);

  const loadControl = useCallback(async (id: string, shouldApply: () => boolean = () => true) => {
    if (!id) return null;
    const response = await fetch(`/api/whatsapp/conversation-control?threadId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: WhatsAppControl; error?: string };
    if (response.status === 409 || response.status === 404) {
      if (shouldApply()) setControl(null);
      return null;
    }
    if (!response.ok) throw new Error(payload.error || `Unable to load WhatsApp controls (HTTP ${response.status})`);
    const next = payload.data || null;
    if (shouldApply()) setControl(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadThreads()
        .then((next) => {
          if (active && next[0]) setSelected((current) => current || String(next[0].id));
        })
        .catch((cause) => {
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadThreads]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.all([loadConversation(selected, () => active), loadControl(selected, () => active)]).catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [selected, loadConversation, loadControl]);

  async function act(action: string, payload: Row) {
    if (!selected) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, threadId: selected, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Action failed (HTTP ${response.status})`);
      await Promise.all([loadThreads(), loadConversation(selected), loadControl(selected)]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function controlAct(action: string, payload: Row = {}) {
    if (!selected) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/whatsapp/conversation-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, threadId: selected, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `WhatsApp control failed (HTTP ${response.status})`);
      await Promise.all([loadThreads(), loadConversation(selected), loadControl(selected)]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendHumanReply() {
    const message = reply.trim();
    if (!message) return;
    const clientRequestId = replyRequestId || crypto.randomUUID();
    if (!replyRequestId) setReplyRequestId(clientRequestId);
    const sent = await controlAct("human_reply", { message, clientRequestId });
    if (sent) {
      setReply("");
      setReplyRequestId("");
      setNotice("Reply queued through the governed WhatsApp outbox.");
    }
  }

  const visible = useMemo(() => threads.filter((row) => {
    const hay = `${text(row.customer_name, "")} ${text(row.customer_id, "")} ${text(row.primary_phone, "")} ${text(row.lastMessage?.channel, "")}`.toLowerCase();
    if (!hay.includes(query.toLowerCase())) return false;
    if (filter === "unassigned") return !text(row.assigned_to, "");
    if (filter === "whatsapp") return text(row.lastMessage?.channel, "") === "whatsapp";
    if (filter === "human") return Boolean(text(row.assigned_to, "")) && text(row.assigned_to, "") !== "ai-orchestrator";
    return true;
  }), [threads, query, filter]);

  const thread = conversation?.thread || null;
  const messages = conversation?.messages || [];
  const assigned = thread ? text(thread.assigned_to, "") : "";
  const routingMode = control?.routing?.mode || "human_only";
  const humanMode = routingMode === "human_only";
  const aiMode = routingMode === "ai_assistant";
  const handoffRow = control?.handoff?.current || null;
  const handoffStatus = text(handoffRow?.status, "");
  const humanOwned = humanMode && (handoffStatus === "staff_active" || Boolean(assigned && assigned !== "ai-orchestrator"));
  const lastInbound = [...messages].reverse().find((message) => text(message.direction, "") === "inbound");
  const withinWindow = Boolean(
    lastInbound
      && serviceWindowCheckedAt > 0
      && serviceWindowCheckedAt - Number(lastInbound.created_at || 0) <= 24 * 60 * 60_000,
  );
  const whatsappCount = threads.filter((row) => text(row.lastMessage?.channel, "") === "whatsapp").length;
  const unassigned = threads.filter((row) => !text(row.assigned_to, "")).length;
  const lastMessage = messages[messages.length - 1];
  const customerName = text(thread?.customer_name || thread?.customer_id, "Customer");
  const phone = text(thread?.primary_phone, "Masked by role");
  const leadId = text(thread?.lead_id, "Not lead-linked");
  const ticket = thread?.ticket as Row | undefined;
  const consentState = text((lastMessage?.payload as Row | undefined)?.consentStatus, "Verified by governed channel policy");
  const isWhatsApp = Boolean(control);
  const canSendHumanReply = Boolean(isWhatsApp && humanMode && control?.canHumanReply && withinWindow && reply.trim() && !busy);
  const modeLabel = humanMode ? "Human only" : aiMode ? "AI Assistant" : "Chatbot only";

  return (
    <OpsShell
      eyebrow="PawSpace team · Customer experience"
      title="Unified conversation & CX queue"
      description="WhatsApp AI Shared Inbox — WATI-style customer operations on PawSpace canonical conversations. UAT/sandbox only; production WhatsApp delivery stays disabled until release certification."
      actions={<><Badge tone="info">UAT sandbox</Badge><Badge tone="warning">Production delivery disabled</Badge></>}
    >
      {error ? <div className={`${teamStyles.panel} ${teamStyles.panelError}`}><b>{error}</b></div> : null}
      {notice ? <div className={teamStyles.panel}><b>{notice}</b></div> : null}
      <div className={styles.shell}>
        <aside className={styles.rail}>
          <div className={styles.brand}><div className={styles.brandMark}>PS</div><div><strong>PawSpace</strong><small>WhatsApp AI Customer Operations</small></div></div>
          <nav className={styles.nav} aria-label="WhatsApp AI navigation">
            <div className={`${styles.navItem} ${styles.navActive}`}><span>Inbox</span><span className={styles.navCount}>{threads.length}</span></div>
            <div className={styles.navItem}><span>Leads</span><span>{threads.filter((row) => row.lead_id).length}</span></div>
            <div className={styles.navItem}><span>Customers</span></div>
            <div className={styles.navItem}><span>Templates</span></div>
            <div className={styles.navItem}><span>AI Handoffs</span></div>
            <div className={styles.navItem}><span>Booking Drafts</span></div>
            <div className={styles.navItem}><span>Audit</span></div>
            <div className={styles.navItem}><span>Settings</span></div>
          </nav>
          <div className={styles.connection}><span className={styles.dot} />WhatsApp UAT connection<br /><b>Sandbox / governed</b><br /><small>External delivery disabled</small></div>
          <div className={styles.operator}><b>CX Operator</b><br /><small>Role-scoped access</small></div>
        </aside>

        <aside className={styles.list}>
          <div className={styles.listTop}>
            <h2>Shared Inbox</h2>
            <input className={styles.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search leads or conversations..." />
            <div className={styles.filters}>
              {[["all", "All"], ["whatsapp", "WhatsApp"], ["unassigned", "Unassigned"], ["human", "Human owned"]].map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={filter === key ? "primary" : "secondary"}
                  onClick={() => setFilter(key)}
                  className={`${styles.filter} ${filter === key ? styles.filterActive : ""}`}
                >
                  {label}{key === "whatsapp" ? ` ${whatsappCount}` : key === "unassigned" ? ` ${unassigned}` : ""}
                </Button>
              ))}
            </div>
          </div>
          <div className={styles.rows}>
            {visible.length === 0 ? (
              <EmptyState title="No conversations match this view." className={styles.empty} />
            ) : visible.map((row) => {
              const owner = text(row.assigned_to, "");
              const isHuman = Boolean(owner && owner !== "ai-orchestrator");
              const channel = text(row.lastMessage?.channel, "thread");
              return (
                <button
                  key={row.id}
                  type="button"
                  className={styles.row}
                  aria-current={selected === row.id ? "true" : undefined}
                  onClick={() => setSelected(row.id)}
                >
                  <div className={styles.rowTop}><strong>{text(row.customer_name || row.customer_id, "Customer")}</strong><small>{when(row.lastMessage?.created_at || row.updated_at)}</small></div>
                  <small>{pretty(channel)} · {text(row.lead_id, "canonical customer")}</small>
                  <small>{text((row.lastMessage?.payload as Row | undefined)?.text || row.lastMessage?.template_key, "No message preview")}</small>
                  <div className={styles.pillWrap}><span className={`${styles.pill} ${isHuman ? styles.pillHuman : channel === "whatsapp" ? "" : styles.pillWarn}`}>{isHuman ? `Human owned · ${owner}` : channel === "whatsapp" ? "WhatsApp open" : "Open"}</span></div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className={styles.chat}>
          {!thread ? (
            <EmptyState title="Select a conversation" body="Open the canonical WhatsApp thread from the shared inbox." className={styles.empty} />
          ) : <>
            <header className={styles.chatHead}>
              <div className={styles.person}><div className={styles.avatar}>{initials(customerName)}</div><div><h2>{customerName}</h2><small>{leadId} · {isWhatsApp ? `${modeLabel}${humanOwned ? ` · Owner: ${assigned}` : ""}` : pretty(lastMessage?.channel || "conversation")}</small></div></div>
              <span className={styles.window}>{isWhatsApp ? (withinWindow ? "WhatsApp service window open" : "Template required") : "Canonical conversation"}</span>
            </header>
            <div className={styles.aiBar}>
              <div>
                <b>{isWhatsApp ? `${modeLabel} routing` : "Non-WhatsApp conversation"}</b><br />
                <span>{!isWhatsApp ? "WhatsApp routing controls apply only to canonical WhatsApp threads." : humanMode ? "Human replies use the governed outbox; AI is blocked for this thread." : aiMode ? "AI may qualify the enquiry; high-impact actions and handoff rules remain governed." : "Chatbot mode is visible but remains fail-closed until the deterministic flow engine is certified."}</span>
              </div>
              <Button size="sm" variant="secondary" className={styles.takeover} disabled={busy || !isWhatsApp || humanOwned} onClick={() => { void controlAct("take_over", { reason: routingReason }); }}>Take over</Button>
            </div>
            <section className={styles.messages}>
              {messages.length === 0 ? (
                <EmptyState title="No messages yet." className={styles.empty} />
              ) : messages.map((message) => (
                <div key={text(message.id)} className={`${styles.bubble} ${text(message.direction, "") === "outbound" ? styles.bubbleOut : ""}`}>
                  <small>{pretty(message.direction)} · {pretty(message.channel)} · {pretty(message.status)}</small>
                  <p>{text(message.payload?.text || message.payload?.message || message.template_key, "Message")}</p>
                  <small>{dateTime(message.created_at)}</small>
                </div>
              ))}
            </section>
            <div className={styles.notice}>This workspace does not bypass consent, quiet-hour, retry or adapter controls. AI may make mistakes. Price, availability, payment, cancellation and provider actions stay governed.</div>
            <footer className={styles.composer}>
              <input
                value={reply}
                onChange={(event) => { setReply(event.target.value); setReplyRequestId(""); }}
                disabled={!isWhatsApp || !humanMode || busy || !withinWindow}
                maxLength={4096}
                placeholder={!isWhatsApp ? "Select a WhatsApp thread to reply" : !humanMode ? "Take over or switch to Human only to reply" : !withinWindow ? "24-hour window closed — use an approved template" : "Reply as PawSpace CX..."}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && canSendHumanReply) { event.preventDefault(); void sendHumanReply(); } }}
              />
              <Button type="button" className={styles.send} disabled={!canSendHumanReply} onClick={() => { void sendHumanReply(); }}>Send</Button>
            </footer>
          </>}
        </main>

        <aside className={styles.inspector}>
          <section className={styles.card}><div className={styles.cardHead}><strong>Lead / Customer</strong><a>Canonical</a></div><div className={styles.kv}><span>Name</span><b>{customerName}</b><span>Phone</span><b>{phone}</b><span>Lead</span><b>{leadId}</b><span>Thread</span><b>{text(thread?.id)}</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Consent Evidence</strong><a>Governed</a></div><div className={styles.kv}><span>WhatsApp</span><b>{consentState}</b><span>Purpose</span><b>Lead response / service</b><span>Marketing</span><b>No</b><span>Opt-out</span><b>Prior opt-out always wins</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Qualification</strong><a>AI summary</a></div><div className={styles.kv}><span>Customer</span><b>{customerName}</b><span>Source</span><b>{leadId}</b><span>Latest channel</span><b>{pretty(lastMessage?.channel)}</b><span>Status</span><b>{pretty(thread?.status)}</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Booking / Ticket Context</strong><a>Read-only</a></div><div className={styles.kv}><span>Ticket</span><b>{text(ticket?.id, "None")}</b><span>Priority</span><b>{pretty(ticket?.priority || "normal")}</b><span>Subject</span><b>{text(ticket?.subject, "No active ticket")}</b><span>Promise</span><b>Never invent slot/price</b></div></section>
          <section className={styles.card}>
            <div className={styles.cardHead}><strong>Conversation Routing</strong><a>{isWhatsApp ? modeLabel : "Not WhatsApp"}</a></div>
            <input className={styles.search} value={routingReason} onChange={(event) => setRoutingReason(event.target.value)} maxLength={240} aria-label="Routing change reason" />
            <div className={styles.actions}>
              <Button size="sm" className={`${styles.action} ${humanMode ? styles.actionPrimary : ""}`} disabled={busy || !isWhatsApp} onClick={() => { void controlAct("set_mode", { mode: "human_only", reason: routingReason }); }}>Human only</Button>
              <Button size="sm" variant="secondary" className={styles.action} disabled title="Chatbot mode unlocks only after deterministic flow-engine certification">Chatbot only</Button>
              <Button size="sm" className={`${styles.action} ${aiMode ? styles.actionGreen : ""}`} disabled={busy || !isWhatsApp} onClick={() => { void controlAct(control?.handoff?.aiPaused ? "resume_ai" : "set_mode", control?.handoff?.aiPaused ? { reason: routingReason } : { mode: "ai_assistant", reason: routingReason }); }}>AI Assistant</Button>
            </div>
            <div className={styles.kv}><span>Provider</span><b>{text(control?.provider, isWhatsApp ? "sandbox simulator" : "—")}</b><span>AI paused</span><b>{control?.handoff?.aiPaused ? "Yes" : "No"}</b><span>Handoff</span><b>{pretty(handoffStatus || "none")}</b><span>Production delivery</span><b>Disabled</b></div>
          </section>
          <section className={styles.card}>
            <div className={styles.cardHead}><strong>Handoff Controls</strong><a>Policy</a></div>
            <div className={styles.actions}>
              <Button size="sm" className={`${styles.action} ${styles.actionPrimary}`} disabled={busy || !isWhatsApp || humanOwned} onClick={() => { void controlAct("take_over", { reason: routingReason }); }}>Take over</Button>
              <Button size="sm" variant="secondary" className={styles.action} disabled={busy || !isWhatsApp || !control?.handoff?.aiPaused} onClick={() => { void controlAct("resume_ai", { reason: routingReason }); }}>Resume AI</Button>
              <Button size="sm" variant="secondary" className={styles.action} disabled={busy} onClick={() => { void act("status", { status: "pending_customer", reason: "Awaiting customer response" }); }}>Await customer</Button>
              <Button size="sm" className={`${styles.action} ${styles.actionGreen}`} disabled={busy} onClick={() => { void act("status", { status: "resolved", reason: "Customer Experience resolved" }); }}>Resolve</Button>
            </div>
          </section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Activity / Audit Trail</strong><a>Canonical</a></div><div className={styles.audit}>{messages.slice(-5).reverse().map((message) => <div className={styles.auditItem} key={`audit-${text(message.id)}`}><span className={styles.auditDot} /><span>{when(message.created_at)} · {pretty(message.channel)} {pretty(message.direction)} · {pretty(message.status)}</span></div>)}{control?.handoff?.events?.slice(-3).reverse().map((event) => <div className={styles.auditItem} key={`handoff-${text(event.id)}`}><span className={styles.auditDot} /><span>{when(event.created_at)} · {pretty(event.event_type)} · {text(event.actor_email)}</span></div>)}{messages.length === 0 && !control?.handoff?.events?.length ? <small>No message events yet.</small> : null}</div></section>
        </aside>
      </div>
    </OpsShell>
  );
}
