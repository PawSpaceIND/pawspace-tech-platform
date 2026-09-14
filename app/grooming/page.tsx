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
 * own sign-in when there is none, which is why this page needs no account-loading wrapper of its own,
 * unlike StayBookingPage.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import GroomingFlow from "../mobile-app/grooming-flow";
import type { LoggedInCustomer } from "../mobile-app/customer-login";
import styles from "../mobile-app/mobile.module.css";

export default function GroomingPage() {
  const [customer, setCustomer] = useState<LoggedInCustomer | null>(null);
  /*
   * Same identity handling as the customer app's Book tab: the cached record is only trusted once
   * /api/identity-session confirms it belongs to the customer this browser is actually signed in as.
   * A cache that names somebody else, or that outlived its session, is cleared rather than believed.
   * Signed out is a valid state here — GroomingFlow renders its own sign-in for that case.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const cached = window.localStorage.getItem("pawspace_customer");
        if (!cached) return;
        const response = await fetch("/api/identity-session", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { data?: { subjectType?: string; subjectId?: string } };
        const signedIn = response.ok && body.data?.subjectType === "customer" ? body.data.subjectId : null;
        const parsed = JSON.parse(cached) as LoggedInCustomer;
        if (!signedIn || parsed.customerId !== signedIn) { window.localStorage.removeItem("pawspace_customer"); return; }
        if (active) setCustomer(parsed);
      } catch { /* Treated as signed out; the flow offers sign-in. */ }
    })();
    return () => { active = false; };
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
        <GroomingFlow customer={customer} onVerified={onVerified} />
      </section>
    </main>
  );
}
