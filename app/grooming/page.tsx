"use client";
/*
 * /grooming — the customer-facing Grooming page.
 *
 * Grooming was the ONLY vertical with no page at its own path. /boarding, /sitting, /walking,
 * /training, /food and /taxi all resolve; /grooming returned a 404 while app/grooming/manage
 * resolved fine, so the parent segment existed and only the page was missing. The codebase already
 * treated the path as a customer surface — it is listed in the customer set in
 * app/components/review-ux-fixes.tsx — and grooming is the vertical the marketing side buys traffic
 * for by name, which makes a 404 here the most expensive kind.
 *
 * GroomingFlow is the same component the in-app Book tab and the home page already mount, so this
 * adds a route, not a second implementation. It takes the signed-in customer or null and renders its
 * own sign-in when there is none; resolving WHICH of those a visitor is happens below.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import GroomingFlow from "../mobile-app/grooming-flow";
import type { LoggedInCustomer } from "../mobile-app/customer-login";
import styles from "../mobile-app/mobile.module.css";

const SESSION_PROBE_TIMEOUT_MS = 8000;

export default function GroomingPage() {
  const [customer, setCustomer] = useState<LoggedInCustomer | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  /*
   * Identity resolution, matching the customer app's Book tab.
   *
   * Two things this must get right, both flagged in review on the first version:
   *
   * The session is the authority, not the cache. An earlier draft returned early when localStorage
   * held nothing, which treated a customer with a perfectly good session — a fresh browser, cleared
   * site data, a sign-in that happened on a surface which did not cache — as signed out.
   * /api/identity-session is therefore always asked, and /api/customer-profile fills in the record
   * whenever the session is real but the cache is absent or names somebody else.
   *
   * GroomingFlow captures its customer prop into state once (`useState(signedInCustomer)`), so a
   * prop that arrives later never reaches it. Nothing renders until the check settles, and the key
   * remounts the flow if the identity changes afterwards — the same shape StayBookingPage uses.
   */
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_PROBE_TIMEOUT_MS);
    void (async () => {
      try {
        const cached = window.localStorage.getItem("pawspace_customer");
        const session = await fetch("/api/identity-session", { cache: "no-store", signal: controller.signal });
        const body = await session.json().catch(() => ({})) as { data?: { subjectType?: string; subjectId?: string } };
        const signedIn = session.ok && body.data?.subjectType === "customer" ? body.data.subjectId : null;
        if (!signedIn) { window.localStorage.removeItem("pawspace_customer"); return; }
        let parsed: LoggedInCustomer | null = null;
        try { parsed = cached ? JSON.parse(cached) as LoggedInCustomer : null; } catch { parsed = null; }
        if (parsed?.customerId === signedIn) { if (active) setCustomer(parsed); return; }
        const profile = await fetch("/api/customer-profile", { cache: "no-store", signal: controller.signal });
        const profileBody = await profile.json().catch(() => ({})) as { data?: LoggedInCustomer };
        if (profile.ok && profileBody.data && active) {
          setCustomer(profileBody.data);
          try { window.localStorage.setItem("pawspace_customer", JSON.stringify(profileBody.data)); } catch { /* Session still holds for this visit. */ }
        }
      } catch { /* Treated as signed out; the flow offers sign-in. */ }
      finally { clearTimeout(timer); if (active) setSessionChecked(true); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, []);
  const onVerified = (identity: LoggedInCustomer) => {
    setCustomer(identity);
    try { window.localStorage.setItem("pawspace_customer", JSON.stringify(identity)); } catch { /* Session still holds for this visit. */ }
  };
  return (
    <main className={styles.stage} data-theme="emerald" data-mode="light" style={{ display: "block", padding: 16 }}>
      <section style={{ maxWidth: 620, margin: "0 auto", background: "var(--ps-surface)", borderRadius: 24, padding: 16 }}>
        <Link href="/mobile-app">My PawSpace</Link>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: "16px 0" }}>Grooming</h1>
        {sessionChecked
          ? <GroomingFlow key={customer?.customerId ?? "guest"} customer={customer} onVerified={onVerified} />
          : <p role="status">Loading your PawSpace account…</p>}
      </section>
    </main>
  );
}
