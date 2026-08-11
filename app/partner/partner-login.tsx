"use client";
import { useState } from "react";
import styles from "../components/marketing/premium-marketing.module.css";

export type LoggedInProvider = { providerId: string; providerName: string; phone: string };

const box: React.CSSProperties = { width: "100%", padding: 12, borderRadius: 12, border: "1px solid var(--ps-border)", marginTop: 14, fontSize: 14, textAlign: "center" };

export default function PartnerLogin({ onLoggedIn }: { onLoggedIn: (provider: LoggedInProvider) => void }) {
  const [stage, setStage] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [sandboxCode, setSandboxCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const requestOtp = async () => {
    setError("");
    if (!/^\d{10}$/.test(phone)) { setError("Enter a valid 10-digit phone number"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/partner-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", phone }) });
      const b = (await r.json()) as { data?: { challengeId: string; sandboxCode: string }; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Unable to send OTP");
      setChallengeId(b.data.challengeId);
      setSandboxCode(b.data.sandboxCode);
      setStage("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to send OTP");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    setError("");
    if (!/^\d{6}$/.test(code)) { setError("Enter the 6-digit code"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/partner-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", challengeId, code, name: name || undefined, cityId: "blr" }) });
      const b = (await r.json()) as { data?: LoggedInProvider; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Incorrect code");
      onLoggedIn(b.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to verify code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} style={{ maxWidth: 440, textAlign: "center" }}>
      <span className={styles.eyebrow}>🐾 Become a caregiver</span>
      <h1 style={{ fontSize: "clamp(28px,4vw,38px)", margin: "10px 0 6px" }}>Sign in to start your application</h1>
      <p style={{ color: "var(--ps-muted)", fontSize: 15 }}>Verify your phone number to create or continue your caregiver application.</p>
      {stage === "phone" && (
        <>
          <input
            type="tel"
            placeholder="10-digit phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
            style={box}
          />
          {error && <p style={{ color: "#b3261e", fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button className={styles.primary} style={{ marginTop: 14, width: "100%" }} disabled={busy} onClick={() => void requestOtp()}>
            {busy ? "Sending…" : "Send OTP"}
          </button>
          <p style={{ fontSize: 11, color: "var(--ps-muted)", marginTop: 10 }}>
            Sandbox: no real SMS is sent yet — the code is shown on the next screen for testing.
          </p>
        </>
      )}
      {stage === "otp" && (
        <>
          <p>Enter the 6-digit code sent to +91 {phone}.</p>
          {sandboxCode && (
            <p style={{ fontSize: 12, background: "var(--ps-cream)", padding: 8, borderRadius: 8, marginTop: 8 }}>
              Sandbox code (no real SMS yet): <b>{sandboxCode}</b>
            </p>
          )}
          <input
            type="text"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            style={box}
          />
          <input
            type="text"
            placeholder="Your name (first time only)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...box, marginTop: 8 }}
          />
          {error && <p style={{ color: "#b3261e", fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button className={styles.primary} style={{ marginTop: 14, width: "100%" }} disabled={busy} onClick={() => void verifyOtp()}>
            {busy ? "Verifying…" : "Verify & continue"}
          </button>
          <button style={{ marginTop: 10, background: "none", border: 0, color: "var(--ps-muted)", cursor: "pointer" }} onClick={() => { setStage("phone"); setError(""); }}>
            ← Change number
          </button>
        </>
      )}
    </section>
  );
}
