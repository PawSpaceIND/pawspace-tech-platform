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
import { SELECTED_SERVICE_ADDRESS_KEY, type ZoneResult } from "../mobile-app/address-picker";
import { loadCustomerAccount } from "../../lib/customer-account-client";
import { defaultStayAddress, validateSavedStayAddress } from "../../lib/stay-saved-address";
import styles from "../mobile-app/mobile.module.css";

const SESSION_PROBE_TIMEOUT_MS = 8000;
const SAVED_ADDRESS_TIMEOUT_MS = 15000;
/* The coordinates a TYPED address carries. AddressPicker.applyCoverage() uses exactly these when an
 * address is verified by PIN/area rather than picked off a Google suggestion, and a saved address has
 * no coordinates of its own, so a saved address is offered on precisely the terms a re-typed one
 * would be. They are a hint only: /api/grooming-service-location geocodes server-side and treats
 * browser coordinates as a fallback, never as location authority. */
const TYPED_LATITUDE = 12.925, TYPED_LONGITUDE = 77.5938;

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
  /*
   * Offer the saved default SERVICE ADDRESS, the way /boarding and /sitting do.
   *
   * Boarding and Sitting mount StayAddress (app/mobile-app/stay-address.tsx), which reads the
   * customer's default address from /api/customer-account, checks its PIN against the live service
   * zone and opens with "Your location <address> / Change Address". Grooming's step 3 mounts a bare
   * AddressPicker instead, so a customer with a perfectly good saved default had to RETYPE it for
   * every grooming booking - and retyping is exactly what defeats address dedupe and mints duplicate
   * rows.
   *
   * The same two helpers do the work here: defaultStayAddress() picks the default (or the only)
   * saved address, and validateSavedStayAddress() resolves it through the SAME /api/service-zone
   * coverage check the picker itself performs - so an address outside the service area is never
   * offered, which is also why an unserviceable or PIN-less address simply leaves step 3 as it is.
   *
   * The resolved address is handed to AddressPicker through its OWN restore channel
   * (SELECTED_SERVICE_ADDRESS_KEY), the session-scoped slot it already reads on mount, so step 3
   * opens with the address filled in and verified and no new address UI is invented for grooming
   * alone. An address the customer verified earlier in this tab is left alone - it is a more recent
   * statement of where they want the groomer than a saved default is.
   */
  const savedAddressCustomerId = customer?.customerId;
  useEffect(() => {
    if (!savedAddressCustomerId) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVED_ADDRESS_TIMEOUT_MS);
    void (async () => {
      try {
        if (window.sessionStorage.getItem(SELECTED_SERVICE_ADDRESS_KEY)) return;
        const account = await loadCustomerAccount(savedAddressCustomerId, { signal: controller.signal });
        if (!active || account.customerId !== savedAddressCustomerId) return;
        const saved = defaultStayAddress(account.addresses);
        if (!saved) return;
        const resolved = await validateSavedStayAddress(saved, controller.signal);
        if (!active || !resolved.zone.serviceAvailable) return;
        // Shaped exactly as a typed verification is: line 1 carries the full doorstep line, line 2
        // keeps the landmark on its own, so editing either one stays coherent inside the picker.
        const addressLine1 = [saved.line1, saved.area, saved.city, saved.postalCode].filter(Boolean).join(", ");
        const addressLine2 = saved.line2?.trim() ?? "";
        const offered: ZoneResult = {
          zone: resolved.zone,
          assignment: resolved.assignment,
          address: [addressLine1, addressLine2].filter(Boolean).join(", "),
          addressLine1,
          addressLine2,
          latitude: TYPED_LATITUDE,
          longitude: TYPED_LONGITUDE,
          placeId: `typed:${resolved.assignment.pincode}`,
          verification: "typed",
        };
        if (!active || window.sessionStorage.getItem(SELECTED_SERVICE_ADDRESS_KEY)) return;
        window.sessionStorage.setItem(SELECTED_SERVICE_ADDRESS_KEY, JSON.stringify(offered));
      } catch {
        /* No saved address on offer, then - step 3 asks for one exactly as it does today. Never a
         * blocking error: the customer can always type an address. */
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [savedAddressCustomerId]);
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
