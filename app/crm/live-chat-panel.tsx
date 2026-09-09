"use client";

import { useState, useEffect, useMemo, useCallback, useRef, FormEvent } from "react";

import { startLiveRefresh } from "../../lib/live-refresh";

interface ThreadItem {
  id: string;
  customer_id: string;
  customer_name: string;
  primary_phone: string | null;
  status: string;
  withinSession?: boolean;
  updated_at: number;
  lastMessage?: {
    text?: string;
    direction?: string;
    channel?: string;
    created_at?: number;
  };
}

interface MessageItem {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  status: string;
  created_at: number;
  payload?: {
    text?: string;
    internalNote?: string;
  };
}

interface ThreadDetail {
  thread: ThreadItem;
  messages: MessageItem[];
  session: {
    lastInboundAt: number;
    isWithin24Hours: boolean;
    sessionExpiresAt: number | null;
  };
  routingMode: string;
  simulationAllowed?: boolean;
  quickReplies: Array<{ code: string; label: string; body: string }>;
}

export default function LiveChatPanel({ notify }: { notify: (msg: string) => void }) {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>("");
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string,string>>({});
  const messageText = drafts[selectedThreadId] || "";
  const setMessageText = (value:string) => setDrafts(current => ({...current,[selectedThreadId]:value}));
  const [listError,setListError] = useState(false);
  const [detailError,setDetailError] = useState(false);
  const listRefresh=useRef<ReturnType<typeof startLiveRefresh>|null>(null);
  const detailRefresh=useRef<ReturnType<typeof startLiveRefresh>|null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sending, setSending] = useState(false);
  const pendingSend = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);
  const sendInFlight = useRef(false);
  const [simulating, setSimulating] = useState(false);
  const [simulateText, setSimulateText] = useState("Hi PawSpace, I'd like to check my pet grooming booking details");

  const loadThreads=useCallback(()=>{listRefresh.current?.refresh();detailRefresh.current?.refresh();},[]);

  useEffect(()=>{
    let active=true;
    const sync=startLiveRefresh(async signal=>{
      const response=await fetch("/api/crm/chat",{cache:"no-store",signal});
      if(!active||signal.aborted)return;
      if(response.status===401||response.status===403){
        setThreads([]);setSelectedThreadId("");setThreadDetail(null);setDrafts({});
      }
      if(!response.ok)throw new Error("Conversation list unavailable");
      const body=await response.json() as {data?:{threads?:ThreadItem[]}};
      if(!active||signal.aborted)return;
      if(!Array.isArray(body.data?.threads))throw new Error("Invalid conversation list");
      setThreads(body.data.threads);setListError(false);setLoading(false);
      setSelectedThreadId(current=>current||body.data?.threads?.[0]?.id||"");
    },{onError:()=>{if(active){setListError(true);setLoading(false);}}});
    listRefresh.current=sync;
    window.addEventListener("online",sync.refresh);
    return()=>{active=false;sync.stop();window.removeEventListener("online",sync.refresh);listRefresh.current=null;};
  },[]);

  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(active){setThreadDetail(null);setDetailError(false);setDetailLoading(Boolean(selectedThreadId));}});
    if(!selectedThreadId)return()=>{active=false;};
    const sync=startLiveRefresh(async signal=>{
      const response=await fetch(`/api/crm/chat?threadId=${encodeURIComponent(selectedThreadId)}`,{cache:"no-store",signal});
      if(!active||signal.aborted)return;
      if([401,403,404].includes(response.status))setThreadDetail(null);
      if(!response.ok)throw new Error("Conversation unavailable");
      const body=await response.json() as {data?:ThreadDetail};
      if(!active||signal.aborted)return;
      if(!body.data||body.data.thread.id!==selectedThreadId)throw new Error("Conversation response mismatch");
      setThreadDetail(body.data);setDetailError(false);setDetailLoading(false);
    },{onError:()=>{if(active){setDetailError(true);setDetailLoading(false);}}});
    detailRefresh.current=sync;
    window.addEventListener("online",sync.refresh);
    return()=>{active=false;sync.stop();window.removeEventListener("online",sync.refresh);detailRefresh.current=null;};
  },[selectedThreadId]);

  // Filter threads
  const filteredThreads = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.customer_name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.lastMessage?.text && t.lastMessage.text.toLowerCase().includes(q))
    );
  }, [threads, searchQuery]);

  // Send message
  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !threadDetail || sendInFlight.current) return;
    const fingerprint = JSON.stringify([threadDetail.thread.id, threadDetail.thread.customer_id, messageText.trim()]);
    if (pendingSend.current?.fingerprint !== fingerprint) pendingSend.current = { fingerprint, clientRequestId: crypto.randomUUID() };
    const clientRequestId = pendingSend.current.clientRequestId;
    sendInFlight.current = true;
    setSending(true);
    try {
      const res = await fetch("/api/crm/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "send_message",
          clientRequestId,
          threadId: threadDetail.thread.id,
          customerId: threadDetail.thread.customer_id,
          text: messageText.trim(),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: { queued?: boolean; messageId?: string; reason?: string };
        error?: string;
      };

      if (res.ok && data.ok) {
        pendingSend.current = null;
        notify("WhatsApp message queued");
        setMessageText("");
        // Refresh detail
        loadThreads();
      } else {
        notify(data.error || data.data?.reason || "Failed to send WhatsApp message");
      }
    } catch {
      notify("Network error while sending message");
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  };

  // Simulate inbound customer message for testing
  const handleSimulateInbound = async () => {
    if (!simulateText.trim() || !threadDetail) return;
    setSimulating(true);
    try {
      const res = await fetch("/api/crm/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "simulate_inbound",
          threadId: threadDetail.thread.id,
          customerId: threadDetail.thread.customer_id,
          text: simulateText.trim(),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        notify("Simulated inbound customer WhatsApp message received");
        // Reload detail and threads
        loadThreads();
      } else {
        notify(data.error || "Failed to simulate inbound message");
      }
    } catch {
      notify("Network error simulating inbound message");
    } finally {
      setSimulating(false);
    }
  };

  // Switch routing mode
  const handleSetMode = async (mode: string) => {
    if (!threadDetail) return;
    try {
      const res = await fetch("/api/crm/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set_mode",
          threadId: threadDetail.thread.id,
          mode,
          reason: `Changed to ${mode} from CRM Live Chat Console`,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        notify(`Conversation mode set to ${mode}`);
        setThreadDetail({ ...threadDetail, routingMode: mode });
      } else {
        notify(data.error || "Failed to change conversation mode");
      }
    } catch {
      notify("Network error changing mode");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 170px)", background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #e2d9ec" }}>
      {/* Conversation header */}
      <div style={{ background: "#24133f", color: "#fff", padding: "10px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>WhatsApp Conversations</span>
        </div>
        <span>Delivery status is shown on each message</span>
      </div>

      {(listError||detailError)&&<div role="alert" style={{padding:"8px 18px",background:"#fff3cd"}}>Conversation updates unavailable. Retrying automatically.</div>}

      {/* Main Split Content */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left: Thread List */}
        <aside style={{ width: 340, borderRight: "1px solid #ede6f5", display: "flex", flexDirection: "column", background: "#faf8fd" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #ede6f5" }}>
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #d4c8e2", fontSize: 13 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, color: "#746b7d" }}>
              <span>{filteredThreads.length} threads</span>
              <button onClick={loadThreads} style={{ background: "none", border: "none", color: "#5d22a8", cursor: "pointer", fontWeight: 600 }}>↻ Refresh</button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {loading && <p style={{ padding: 16, color: "#746b7d", fontSize: 13 }}>Loading threads…</p>}
            {!loading && filteredThreads.length === 0 && (
              <p style={{ padding: 16, color: "#746b7d", fontSize: 13 }}>No active WhatsApp conversation threads found.</p>
            )}
            {filteredThreads.map((t) => {
              const isSelected = t.id === selectedThreadId;
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid #f0ebf7",
                    cursor: "pointer",
                    background: isSelected ? "#efe6f9" : "transparent",
                    transition: "background 0.15s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <strong style={{ fontSize: 13, color: "#24133f" }}>{t.customer_name}</strong>
                    <span style={{ fontSize: 11, color: "#8a7e96" }}>
                      {t.updated_at ? new Date(t.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#6e637a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.lastMessage?.text || (t.lastMessage ? "Message" : "No messages yet")}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: t.withinSession ? "#d4f4dd" : "#f4e0d4", color: t.withinSession ? "#13632e" : "#873200" }}>
                      {t.withinSession ? "24h Session Open" : "Template Required"}
                    </span>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "#e8e2f0", color: "#4c3866" }}>
                      {t.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right: Message Stream & Composer */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fff" }}>
          {!selectedThreadId && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8a7e96" }}>
              Select a conversation thread to view WhatsApp messages
            </div>
          )}

          {selectedThreadId && threadDetail && (
            <>
              {/* Conversation Header */}
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #ede6f5", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fbfafc" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, color: "#24133f" }}>{threadDetail.thread.customer_name}</h3>
                  <small style={{ color: "#746b7d" }}>
                    ID: {threadDetail.thread.customer_id} · Thread: {threadDetail.thread.id}
                  </small>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "#6a5e78" }}>Mode:</span>
                  <select
                    value={threadDetail.routingMode}
                    onChange={(e) => handleSetMode(e.target.value)}
                    style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d4c8e2", fontSize: 12 }}
                  >
                    <option value="human_only">Human Only (Agent)</option>
                    <option value="ai_assistant">AI Assistant</option>
                    <option value="chatbot_only">Chatbot Automated</option>
                  </select>
                  <span style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, background: threadDetail.session.isWithin24Hours ? "#d4f4dd" : "#ffedd5", color: threadDetail.session.isWithin24Hours ? "#13632e" : "#9a3412" }}>
                    {threadDetail.session.isWithin24Hours ? "✓ 24h Customer-Service Window Active" : "⚠ Outside 24h Window"}
                  </span>
                </div>
              </div>

              {/* Message Transcript */}
              <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 12, background: "#f9f8fb" }}>
                {detailLoading && <p style={{ color: "#746b7d", fontSize: 13 }}>Loading conversation history…</p>}
                {!detailLoading && threadDetail.messages.length === 0 && (
                  <p style={{ color: "#746b7d", fontSize: 13, textAlign: "center", marginTop: 40 }}>No messages in this conversation thread yet.</p>
                )}
                {threadDetail.messages.map((m) => {
                  const isInbound = m.direction === "inbound";
                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: isInbound ? "flex-start" : "flex-end",
                        maxWidth: "70%",
                        background: isInbound ? "#ffffff" : "#4b168c",
                        color: isInbound ? "#24133f" : "#ffffff",
                        padding: "10px 14px",
                        borderRadius: isInbound ? "14px 14px 14px 2px" : "14px 14px 2px 14px",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                        border: isInbound ? "1px solid #e8e2f0" : "none",
                      }}
                    >
                      <div style={{ fontSize: 13, lineHeight: 1.45, wordBreak: "break-word" }}>
                        {m.payload?.text || JSON.stringify(m.payload || "")}
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, color: isInbound ? "#8c8299" : "#d8c7ef" }}>
                        <span>{new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        <span>·</span>
                        <span>{m.status}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quick Replies Picker */}
              {threadDetail.quickReplies && threadDetail.quickReplies.length > 0 && (
                <div style={{ padding: "6px 16px", background: "#f3eff8", borderTop: "1px solid #ede6f5", display: "flex", gap: 8, overflowX: "auto" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#6a5e78", alignSelf: "center", whiteSpace: "nowrap" }}>Quick Replies:</span>
                  {threadDetail.quickReplies.map((qr) => (
                    <button
                      key={qr.code}
                      type="button"
                      onClick={() => setMessageText(qr.body)}
                      style={{ padding: "4px 9px", background: "#fff", border: "1px solid #d9d0e5", borderRadius: 14, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
                    >
                      {qr.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Message Composer */}
              <form onSubmit={handleSendMessage} style={{ padding: "12px 18px", borderTop: "1px solid #ede6f5", background: "#fff", display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="text"
                  placeholder={threadDetail.session.isWithin24Hours ? "Type WhatsApp message..." : "Type approved template message..."}
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid #d4c8e2", fontSize: 13 }}
                />
                <button
                  type="submit"
                  disabled={sending || !messageText.trim()}
                  style={{ padding: "10px 18px", background: "#4b168c", color: "white", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: sending || !messageText.trim() ? 0.6 : 1 }}
                >
                  {sending ? "Sending…" : "Send WhatsApp"}
                </button>
              </form>

              {/* Sandbox Inbound Simulator Toolbar */}
              {threadDetail.simulationAllowed && <div style={{ padding: "8px 18px", background: "#f8f6fb", borderTop: "1px dashed #dcd3e7", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                <span style={{ color: "#746b7d", fontWeight: 700 }}>Sandbox Test:</span>
                <input
                  type="text"
                  value={simulateText}
                  onChange={(e) => setSimulateText(e.target.value)}
                  placeholder="Simulate customer reply..."
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #ded6e9", fontSize: 12 }}
                />
                <button
                  type="button"
                  onClick={handleSimulateInbound}
                  disabled={simulating || !simulateText.trim()}
                  style={{ padding: "6px 12px", background: "#2e7d32", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: simulating ? 0.6 : 1 }}
                >
                  {simulating ? "Simulating…" : "⚡ Simulate Customer Inbound"}
                </button>
              </div>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
