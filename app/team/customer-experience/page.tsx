"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState } from "../../components/ui";
import OpsShell from "../../components/ops-shell/OpsShell";
import teamStyles from "../team-console.module.css";
import styles from "./whatsapp-inbox.module.css";

type Cursor = { at: number; id: string };
type Row = Record<string, unknown>;
type CommunicationState = {
  bookingId?: string;
  state?: "pending" | "failed";
  label?: string;
  outboxStatus?: string;
  attemptCount?: number;
  maxAttempts?: number;
  nextAttemptAt?: number | null;
  lastError?: string;
};
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
  communicationState?: CommunicationState | null;
};
type Conversation = {
  thread: Row;
  participants: Row[];
  messages: Array<Row & { payload?: Row }>;
  assignments: Row[];
  notes?: Array<{id:string;actorEmail:string;body:string;createdAt:number}>;
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
const inboxRefreshMs = 5_000;

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
  const [cursorHistory, setCursorHistory] = useState<Cursor[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const currentCursor = cursorHistory.at(-1);
  const [filter, setFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [drafts, setDrafts] = useState<Record<string, { text: string; clientRequestId: string }>>({});
  const reply = drafts[selected]?.text || "";
  const replyRequestId = drafts[selected]?.clientRequestId || "";
  const [internalNote, setInternalNote] = useState("");
  const [noteRequestId, setNoteRequestId] = useState("");
  const activeThread = useRef("");
  const mutationInFlight = useRef(false);

  const [routingReason, setRoutingReason] = useState("CX operator routing decision");
  const accessEpoch = useRef(0);
  const clearAccess = useCallback((threadId?: string) => {
    accessEpoch.current++;
    if (threadId) {
      setThreads(current => current.filter(row => row.id !== threadId));
      setDrafts(current => { const next = { ...current }; delete next[threadId]; return next; });
    } else {
      setThreads([]); setDrafts({}); setQuery(""); setCursorHistory([]); setNextCursor(null); setInternalNote(""); setNoteRequestId("");
    }
    if (!threadId || activeThread.current === threadId) {
      activeThread.current = "";
      setSelected(""); setConversation(null); setControl(null); setNotice("");
      setServiceWindowCheckedAt(0); setRoutingReason("CX operator routing decision");
    }
  }, []);
  const selectThread = (id: string) => {
    if (activeThread.current === id) return;
    activeThread.current = id;
    setInternalNote(""); setNoteRequestId("");
    setSelected(id); setConversation(null); setControl(null); setError(""); setNotice("");
  };

  const loadThreads = useCallback(async (shouldApply: () => boolean = () => true) => {
    const epoch = accessEpoch.current;
    const params = new URLSearchParams({ limit: "50" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (query.trim()) params.set("q", query.trim());
    if (filter === "whatsapp") params.set("channel", filter);
    if (filter === "unassigned" || filter === "human") params.set("ownership", filter);
    if (currentCursor) params.set("cursor", JSON.stringify(currentCursor));
    const response = await fetch(`/api/conversations?${params}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: { threads: Thread[]; nextCursor?: Cursor | null }; error?: string };
    if (epoch !== accessEpoch.current || !shouldApply()) return [];
    if ([401, 403].includes(response.status)) clearAccess();

    if (!response.ok) throw new Error(payload.error || `Unable to load conversations (HTTP ${response.status})`);
    const next = payload.data?.threads || [];
    if (shouldApply()) { setThreads(next); setNextCursor(payload.data?.nextCursor || null); }
    return next;
  }, [statusFilter, query, filter, currentCursor, clearAccess]);


  const loadConversation = useCallback(async (id: string, shouldApply: () => boolean = () => true) => {
    if (!id) return;
    const epoch = accessEpoch.current;
    const response = await fetch(`/api/conversations?threadId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: Conversation; error?: string };
    if (!shouldApply() || epoch !== accessEpoch.current) return;
    if ([401, 403, 404].includes(response.status)) clearAccess(response.status === 401 ? undefined : id);
    if (!response.ok) throw new Error(payload.error || `Unable to load conversation (HTTP ${response.status})`);
    if (!shouldApply() || activeThread.current !== id) return;
    setConversation(payload.data || null);
    setServiceWindowCheckedAt(Date.now());
  }, [clearAccess]);

  const loadControl = useCallback(async (id: string, shouldApply: () => boolean = () => true) => {
    if (!id) return null;
    const epoch = accessEpoch.current;
    const response = await fetch(`/api/whatsapp/conversation-control?threadId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: WhatsAppControl; error?: string };
    if (!shouldApply() || epoch !== accessEpoch.current) return null;
    if ([401, 403].includes(response.status)) clearAccess(response.status === 401 ? undefined : id);
    if (response.status === 409 || response.status === 404) {
      if (shouldApply() && activeThread.current === id) setControl(null);
      return null;
    }
    if (!response.ok) throw new Error(payload.error || `Unable to load WhatsApp controls (HTTP ${response.status})`);
    const next = payload.data || null;
    if (shouldApply() && activeThread.current === id) setControl(next);
    return next;
  }, [clearAccess]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (!active || refreshing) return;
      refreshing = true;
      try {
        const next = await loadThreads(() => active);
        if (active && next[0] && !activeThread.current) {
          activeThread.current = String(next[0].id);
          setSelected(String(next[0].id));
        }

        if (active) setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const refreshFromEvent = () => { void refresh(); };
    window.addEventListener("pawspace:conversation-refresh", refreshFromEvent);
    const timer = window.setInterval(refreshFromEvent, inboxRefreshMs);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pawspace:conversation-refresh", refreshFromEvent);
    };
  }, [loadThreads]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (!active || refreshing) return;
      refreshing = true;
      try {
        await Promise.all([loadConversation(selected, () => active), loadControl(selected, () => active)]);
        if (active) setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const refreshFromEvent = () => { void refresh(); };
    window.addEventListener("pawspace:conversation-refresh", refreshFromEvent);
    const timer = window.setInterval(refreshFromEvent, inboxRefreshMs);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pawspace:conversation-refresh", refreshFromEvent);
    };
  }, [selected, loadConversation, loadControl]);

  async function act(action: string, payload: Row) {
    if (!selected || conversation?.thread.id !== selected || mutationInFlight.current) return false;
    const target = selected;
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, threadId: target, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Action failed (HTTP ${response.status})`);
      await Promise.all([loadThreads(), loadConversation(target), loadControl(target)]);
      return true;
    } catch (cause) {
      if (activeThread.current === target) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }

  async function saveInternalNote() {
    if (!selected || !internalNote.trim() || busy) return;
    const key = noteRequestId || crypto.randomUUID();
    setNoteRequestId(key);
    if (await act("add_internal_note", { note: internalNote, idempotencyKey: key })) {
      setInternalNote(""); setNoteRequestId(""); setNotice("Internal note saved.");
    }
  }

  async function controlAct(action: string, payload: Row = {}) {
    if (!selected || conversation?.thread.id !== selected || mutationInFlight.current) return false;
    const target = selected;
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/whatsapp/conversation-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, threadId: target, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `WhatsApp control failed (HTTP ${response.status})`);
      await Promise.all([loadThreads(), loadConversation(target), loadControl(target)]);
      return true;
    } catch (cause) {
      if (activeThread.current === target) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }

  async function sendHumanReply() {
    const message = reply.trim();
    if (!message || conversation?.thread.id !== selected || control?.threadId !== selected || mutationInFlight.current) return;
    const target = selected;
    const submittedText = reply;
    const clientRequestId = replyRequestId || crypto.randomUUID();
    if (!replyRequestId) setDrafts(current => ({ ...current, [target]: { text: submittedText, clientRequestId } }));
    const sent = await controlAct("human_reply", { message, clientRequestId });
    if (sent) {
      setDrafts(current => current[target]?.text === submittedText && current[target]?.clientRequestId === clientRequestId
        ? { ...current, [target]: { text: "", clientRequestId: "" } } : current);
      if (activeThread.current === target) setNotice("Reply queued through the governed WhatsApp outbox.");
    }
  }

  const visible = threads;


  const thread = conversation?.thread || null;
  const selectedThread = threads.find(row => row.id === selected) || null;
  const communicationState = selectedThread?.communicationState || null;
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
  const lastMessage = messages[messages.length - 1];
  const customerName = text(thread?.customer_name || thread?.customer_id, "Customer");
  const phone = text(thread?.primary_phone, "Masked by role");
  const leadId = text(thread?.lead_id, "Not lead-linked");
  const ticket = thread?.ticket as Row | undefined;
  const booking = thread?.booking as Row | undefined;
  const consentState = text((lastMessage?.payload as Row | undefined)?.consentStatus, "Verified by governed channel policy");
  const isWhatsApp = Boolean(control);
  const canSendHumanReply = Boolean(conversation?.thread.id === selected && control?.threadId === selected && isWhatsApp && humanMode && control?.canHumanReply && withinWindow && reply.trim() && !busy);
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
            <input className={styles.search} value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setCursorHistory([]); setNextCursor(null); }} placeholder="Search leads or conversations..." />
            <label>Conversation status
              <select aria-label="Conversation status" disabled={busy} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setCursorHistory([]); setNextCursor(null); setDrafts({}); setInternalNote(""); setNoteRequestId(""); activeThread.current=""; setSelected(""); setConversation(null); setControl(null); setThreads([]); }}>
                <option value="open">Open</option><option value="pending_customer">Awaiting customer</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="all">All statuses</option>
              </select>
            </label>
            <div className={styles.filters}>
              {[["all", "All"], ["whatsapp", "WhatsApp"], ["unassigned", "Unassigned"], ["human", "Human owned"]].map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={filter === key ? "primary" : "secondary"}
                  onClick={() => { setFilter(key); setCursorHistory([]); setNextCursor(null); }}
                  className={`${styles.filter} ${filter === key ? styles.filterActive : ""}`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className={styles.filters}>
            <span>Showing {threads.length} conversations on this page</span>
            <Button size="sm" disabled={busy || cursorHistory.length === 0} onClick={() => { setCursorHistory(history => history.slice(0, -1)); setNextCursor(null); }}>Previous page</Button>
            <Button size="sm" disabled={busy || !nextCursor} onClick={() => { if (nextCursor) setCursorHistory(history => [...history, nextCursor]); setNextCursor(null); }}>Next page</Button>
          </div>
          <div className={styles.rows}>
            {visible.length === 0 ? (
              <EmptyState title="No conversations match this view." className={styles.empty} />
            ) : visible.map((row) => {
              const owner = text(row.assigned_to, "");
              const isHuman = Boolean(owner && owner !== "ai-orchestrator");
              const channel = text(row.lastMessage?.channel, "thread");
              const comm = row.communicationState;
              return (
                <button
                  key={row.id}
                  type="button"
                  disabled={busy}
                  className={styles.row}
                  aria-current={selected === row.id ? "true" : undefined}
                  onClick={() => { setInternalNote(""); setNoteRequestId(""); selectThread(row.id); }}
                >
                  <div className={styles.rowTop}><strong>{text(row.customer_name || row.customer_id, "Customer")}</strong><small>{when(row.lastMessage?.created_at || row.updated_at)}</small></div>
                  <small>{pretty(channel)} · {text(row.lead_id, "canonical customer")}</small>
                  <small>{text(row.lastMessage?.text, row.lastMessage ? "Message" : "No messages yet")}</small>
                  {comm ? <div className={`${styles.communicationFlag} ${comm.state === "failed" ? styles.communicationFlagFailed : styles.communicationFlagPending}`} role="status"><b>{text(comm.label)}</b><span>Booking {text(comm.bookingId)} · customer may not know payment succeeded</span></div> : null}
                  <div className={styles.pillWrap}><span className={`${styles.pill} ${isHuman ? styles.pillHuman : channel === "whatsapp" ? "" : styles.pillWarn}`}>{isHuman ? `Human owned · ${owner} · ${pretty(row.status || "open")}` : pretty(row.status || "open")}</span></div>

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
            {communicationState ? <div className={`${styles.communicationBanner} ${communicationState.state === "failed" ? styles.communicationBannerFailed : styles.communicationBannerPending}`} role="alert"><div><b>{text(communicationState.label)}</b><span>Financial confirmation is complete, but the mandatory customer communication has not been delivered.</span></div><small>Booking {text(communicationState.bookingId)} · {pretty(communicationState.outboxStatus)}{communicationState.attemptCount ? ` · attempt ${communicationState.attemptCount}${communicationState.maxAttempts ? `/${communicationState.maxAttempts}` : ""}` : ""}{communicationState.lastError ? ` · ${text(communicationState.lastError)}` : ""}</small></div> : null}
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
                  <p>{message.payload?.mediaPending ? "Attachment not yet available" : text(message.payload?.text || message.payload?.message || message.payload?.body || message.payload?.notice || message.template_key, "Message")}</p>
                  {Boolean(message.payload?.media) && !Boolean(message.payload?.mediaPending) && <a href={`/api/conversation-media?messageId=${encodeURIComponent(text(message.id))}`} target="_blank" rel="noreferrer">Open attachment</a>}

                  <small>{dateTime(message.created_at)}</small>
                </div>
              ))}
            </section>
            <div className={styles.notice}>This workspace does not bypass consent, quiet-hour, retry or adapter controls. AI may make mistakes. Price, availability, payment, cancellation and provider actions stay governed.</div>
            <footer className={styles.composer}>
              <input
                value={reply}
                onChange={(event) => { const value = event.target.value; setDrafts(current => ({ ...current, [selected]: { text: value, clientRequestId: "" } })); }}
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
          {communicationState ? <section className={`${styles.card} ${styles.communicationContext}`}><div className={styles.cardHead}><strong>Customer Awareness Risk</strong><a>{communicationState.state === "failed" ? "Action required" : "Delivery pending"}</a></div><div className={styles.kv}><span>Booking</span><b>{text(communicationState.bookingId)}</b><span>Financial state</span><b>Confirmed / captured</b><span>Customer state</span><b>Confirmation may be unseen</b><span>Queue</span><b>{pretty(communicationState.outboxStatus)}</b></div></section> : null}
          <section className={styles.card}><div className={styles.cardHead}><strong>Consent Evidence</strong><a>Governed</a></div><div className={styles.kv}><span>WhatsApp</span><b>{consentState}</b><span>Purpose</span><b>Lead response / service</b><span>Marketing</span><b>No</b><span>Opt-out</span><b>Prior opt-out always wins</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Qualification</strong><a>AI summary</a></div><div className={styles.kv}><span>Customer</span><b>{customerName}</b><span>Source</span><b>{leadId}</b><span>Latest channel</span><b>{pretty(lastMessage?.channel)}</b><span>Status</span><b>{pretty(thread?.status)}</b></div></section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Booking / Ticket Context</strong><a>Read-only</a></div><div className={styles.kv}><span>Booking</span><b>{text(booking?.id || thread?.booking_id, "Not linked")}</b><span>Service</span><b>{pretty(booking?.service_code)}</b><span>Package</span><b>{text(booking?.package_name)}</b><span>Booking status</span><b>{pretty(booking?.status)}</b><span>Scheduled start</span><b>{text(booking?.scheduled_start)}</b><span>Ticket</span><b>{text(ticket?.id || thread?.ticket_id, "Not linked")}</b><span>Priority</span><b>{pretty(ticket?.priority)}</b><span>Subject</span><b>{text(ticket?.subject, "No linked ticket details")}</b><span>Ticket status</span><b>{pretty(ticket?.status)}</b><span>Response due</span><b>{dateTime(ticket?.sla_due_at)}</b></div></section>
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
              <Button size="sm" variant="secondary" className={styles.action} disabled={busy || !selected} onClick={() => { void act("status", { status: "pending_customer", reason: "Awaiting customer response" }); }}>Await customer</Button>
              <Button size="sm" variant="secondary" className={styles.action} disabled={busy || !selected || thread?.status === "open"} onClick={() => { void act("status", { status: "open", reason: "Customer Experience reopened" }); }}>Reopen</Button>
              <Button size="sm" className={`${styles.action} ${styles.actionGreen}`} disabled={busy || !selected} onClick={() => { void act("status", { status: "resolved", reason: "Customer Experience resolved" }); }}>Resolve</Button>
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.cardHead}><strong>Internal notes</strong></div>
            <textarea aria-label="Internal note" className={styles.noteInput} value={internalNote} maxLength={4096} disabled={busy || !selected} onChange={event => { setInternalNote(event.target.value); setNoteRequestId(""); }} placeholder="Add a staff note for this conversation" />
            <Button size="sm" disabled={busy || !selected || !internalNote.trim()} onClick={() => { void saveInternalNote(); }}>Save internal note</Button>
            <div className={styles.audit}>{conversation?.notes?.length ? conversation.notes.map(note => <div className={styles.note} key={note.id}><small>{dateTime(note.createdAt)} · {note.actorEmail}</small><p>{note.body}</p></div>) : <small>No internal notes yet.</small>}</div>
          </section>
          <section className={styles.card}><div className={styles.cardHead}><strong>Activity / Audit Trail</strong><a>Canonical</a></div><div className={styles.audit}>{messages.slice(-5).reverse().map((message) => <div className={styles.auditItem} key={`audit-${text(message.id)}`}><span className={styles.auditDot} /><span>{when(message.created_at)} · {pretty(message.channel)} {pretty(message.direction)} · {pretty(message.status)}</span></div>)}{control?.handoff?.events?.slice(-3).reverse().map((event) => <div className={styles.auditItem} key={`handoff-${text(event.id)}`}><span className={styles.auditDot} /><span>{when(event.created_at)} · {pretty(event.event_type)} · {text(event.actor_email)}</span></div>)}{messages.length === 0 && !control?.handoff?.events?.length ? <small>No message events yet.</small> : null}</div></section>
        </aside>
      </div>
    </OpsShell>
  );
}