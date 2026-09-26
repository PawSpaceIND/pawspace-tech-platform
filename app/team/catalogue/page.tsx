"use client";
import Link from "next/link";
import { useState } from "react";
import StaffModule from "../../components/staff-workspace/StaffModule";
import PricingControlPanel from "../../control/pricing-control-panel";

const wrap = { minHeight: "100vh", background: "var(--staff-bg)", padding: 28, fontFamily: "inherit", color: "var(--staff-text)" } as const;

/**
 * The separate catalogue list this page used to edit (catalogue_packages) was never read by any
 * booking or price quote, so staff could change a price here and see nothing happen. It is retired:
 * packages, prices and slots are managed only in Pricing Control, which every booking flow reads.
 */
export default function CataloguePage() {
  const [toast, setToast] = useState("");
  const notify = (message: string) => { setToast(message); setTimeout(() => setToast(""), 2300); };
  return <StaffModule><main style={wrap}><div style={{ maxWidth: 1200, margin: "0 auto" }}>
    <p style={{ margin: "0 0 6px", color: "var(--staff-muted)", fontSize: 12, fontWeight: 800, letterSpacing: ".08em" }}>PAWSPACE · PRICING CONTROL</p>
    <h1 style={{ margin: "0 0 8px" }}>Packages, prices and slots</h1>
    <p style={{ margin: "0 0 16px", color: "var(--staff-muted)" }}>This is the one place bookings read prices from. The old catalogue list has been retired because no booking used it. The same controls are also in <Link href="/control" style={{ color: "var(--staff-gold)" }}>Founder &amp; system controls</Link> → Pricing.</p>
    {toast && <div role="status" style={{ padding: 12, background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 10, marginBottom: 12 }}>{toast}</div>}
    <PricingControlPanel notify={notify} />
  </div></main></StaffModule>;
}
