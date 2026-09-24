"use client";
import { useEffect, useRef, useState } from "react";
import { apiRequest, apiSend } from "../../lib/api-fetch";

type Persona = { key: string; name: string };
export default function CustomerTestAccess({ code }: { code: string }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest("/api/uat-customer-switch", { cache: "no-store", signal: controller.signal }).then(({ ok, body }) => {
      const result = body as { enabled?: boolean; personas?: Persona[] } | undefined;
      if (!controller.signal.aborted && ok && result?.enabled && Array.isArray(result.personas)) setPersonas(result.personas);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  async function select(persona: string) {
    if (lock.current) return;
    if (!code.trim()) { setMessage("Enter the UAT access code above first."); return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      await apiSend("/api/uat-customer-switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), persona }) });
      window.location.assign("/mobile-app");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Test sign-in could not be confirmed."); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!personas.length) return null;
  return <section aria-label="Synthetic customer testing" style={{ marginTop: 24 }}>
    <h2 style={{ fontSize: 17 }}>Test customers - no OTP</h2>
    <p style={{ fontSize: 13 }}>Isolated staging only. Switch to a fixed synthetic customer with normal customer permissions. This replaces the current staff session. No real phone ownership is asserted.</p>
    <div style={{ display: "grid", gap: 8 }}>{personas.map(persona => <button key={persona.key} type="button" disabled={busy}
      onClick={() => void select(persona.key)} style={{ padding: 12, cursor: "pointer", borderRadius: 8 }}>
      {busy ? "Starting test session..." : persona.name}
    </button>)}</div>
    {message ? <p role="alert">{message}</p> : null}
    <p style={{ fontSize: 12 }}>Sessions expire within 24 hours. Turning off test-customer access denies these sessions; ordinary OTP, permissions, payments and consent checks remain active.</p>
  </section>;
}
