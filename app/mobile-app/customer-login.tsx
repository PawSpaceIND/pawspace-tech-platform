"use client";
import { useEffect, useState } from "react";
import styles from "./mobile.module.css";

export type LoggedInCustomer = { customerId: string; customerName: string; phone: string };

type DevOtpSession = {
  phone: string;
  challengeId: string;
  sandboxCode: string;
};

const DEV_OTP_SESSION_KEY = "pawspace:customer-login:otp";
const persistDevOtpSession = process.env.NODE_ENV === "development";

export default function CustomerLogin({ onLoggedIn, embedded = false }: { onLoggedIn: (customer: LoggedInCustomer) => void; embedded?: boolean }) {
  const [hydrated, setHydrated] = useState(false);
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [sandboxCode, setSandboxCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The login shell is server-rendered. Delay client-state restoration until after hydration so the
  // SSR controls stay inert until React handlers are attached, while a dev-only remount can still
  // recover the outstanding sandbox OTP challenge without resetting the customer to the phone stage.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHydrated(true);
      if (!persistDevOtpSession) return;
      try {
        const raw = sessionStorage.getItem(DEV_OTP_SESSION_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) as Partial<DevOtpSession>;
        if (!/^\d{10}$/.test(saved.phone || "") || !saved.challengeId) {
          sessionStorage.removeItem(DEV_OTP_SESSION_KEY);
          return;
        }
        setPhone(saved.phone || "");
        setChallengeId(saved.challengeId);
        setSandboxCode(saved.sandboxCode || "");
        setStage("code");
      } catch {
        sessionStorage.removeItem(DEV_OTP_SESSION_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const requestOtp = async () => {
    setError("");
    if (!/^\d{10}$/.test(phone)) { setError("Enter a valid 10-digit phone number"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/customer-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", phone }) });
      const b = (await r.json()) as { data?: { challengeId: string; sandboxCode: string }; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Unable to send OTP");
      setChallengeId(b.data.challengeId);
      setSandboxCode(b.data.sandboxCode);
      if (persistDevOtpSession) {
        sessionStorage.setItem(DEV_OTP_SESSION_KEY, JSON.stringify({
          phone,
          challengeId: b.data.challengeId,
          sandboxCode: b.data.sandboxCode,
        } satisfies DevOtpSession));
      }
      setStage("code");
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
      const r = await fetch("/api/customer-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", challengeId, code, name: name || undefined, cityId: "blr" }) });
      const b = (await r.json()) as { data?: LoggedInCustomer; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Incorrect code");
      if (persistDevOtpSession) sessionStorage.removeItem(DEV_OTP_SESSION_KEY);
      onLoggedIn(b.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to verify code");
    } finally {
      setBusy(false);
    }
  };

  const body = (
          <div className={styles.starter}>
            <i>🐾</i>
            <h3 style={{ margin: "10px 0" }}>Welcome to PawSpace</h3>
            {stage === "phone" && (
              <>
                <p>Enter your phone number to sign in or create your account.</p>
                <input
                  type="tel"
                  placeholder="10-digit phone number"
                  aria-label="Phone number"
                  value={phone}
                  disabled={!hydrated}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid var(--ps-border)", marginTop: 14, fontSize: 14, textAlign: "center" }}
                />
                {error && <p style={{ color: "#b3261e", fontSize: 11, marginTop: 8 }}>{error}</p>}
                <button className={styles.primary} disabled={!hydrated || busy} onClick={() => void requestOtp()}>
                  {busy ? "Sending…" : "Send OTP"}
                </button>
                <p style={{ fontSize: 9, color: "var(--ps-muted)", marginTop: 10 }}>
                  UAT sandbox: no real SMS is sent yet - the code is shown on the next screen for testing.
                </p>
              </>
            )}
            {stage === "code" && (
              <>
                <p>Enter the 6-digit code sent to +91 {phone}.</p>
                {sandboxCode && (
                  <p style={{ fontSize: 11, background: "var(--ps-surface-2)", padding: 8, borderRadius: 8, marginTop: 8 }}>
                    Sandbox code (no real SMS yet): <b>{sandboxCode}</b>
                  </p>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="6-digit code"
                  aria-label="OTP code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid var(--ps-border)", marginTop: 10, fontSize: 14, textAlign: "center" }}
                />
                <input
                  type="text"
                  placeholder="Your name (first time only)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid var(--ps-border)", marginTop: 8, fontSize: 14, textAlign: "center" }}
                />
                {error && <p style={{ color: "#b3261e", fontSize: 11, marginTop: 8 }}>{error}</p>}
                <button className={styles.primary} disabled={busy} onClick={() => void verifyOtp()}>
                  {busy ? "Verifying…" : "Verify & continue"}
                </button>
                <button className={styles.back} onClick={() => {
                  if (persistDevOtpSession) sessionStorage.removeItem(DEV_OTP_SESSION_KEY);
                  setStage("phone");
                  setChallengeId("");
                  setSandboxCode("");
                  setCode("");
                  setError("");
                }}>
                  ← Change number
                </button>
              </>
            )}
          </div>
  );
  if (embedded) return body;
  return (
    <main className={styles.stage} data-theme="emerald" data-mode="light">
      <section className={styles.phone}>
        <div className={styles.screen}>{body}</div>
      </section>
    </main>
  );
}