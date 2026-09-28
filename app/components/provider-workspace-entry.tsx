"use client";
import Link from "next/link";
import { useState } from "react";

export default function ProviderWorkspaceEntry({ eyebrow, title, blurb, basePath, demoBookingId, demoLabel, customerHref, customerLabel, opsHref, opsLabel }: {
  eyebrow: string; title: string; blurb: string; basePath: string;
  demoBookingId: string; demoLabel: string;
  customerHref: string; customerLabel: string; opsHref: string; opsLabel: string;
}) {
  const [lookup, setLookup] = useState("");
  const open = (id: string) => { const trimmed = id.trim(); if (trimmed) window.location.assign(`${basePath}?bookingId=${encodeURIComponent(trimmed)}`); };
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px", fontFamily: "var(--paw-font, system-ui)", background: "radial-gradient(circle at 80% 10%,var(--paw-bg) 0,transparent 28%),var(--paw-surface)", color: "var(--paw-link)" }}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" style={{ width: 128, height: 52, objectFit: "contain", objectPosition: "left center" }} />
          <span style={{ padding: "7px 10px", borderRadius: 999, border: "1px solid var(--paw-line)", background: "var(--paw-surface)", color: "var(--paw-link)", fontSize: 11, fontWeight: 850 }}>Verified workspace</span>
        </div>
        <section style={{ background: "var(--paw-surface)", border: "1px solid var(--paw-line)", borderRadius: "calc(22px * var(--paw-radius-scale))", padding: 28, boxShadow: "0 18px 46px rgba(20,55,45,.08)" }}>
          <p style={{ fontWeight: 900, letterSpacing: 1.7, color: "var(--paw-text)", fontSize: 10, margin: 0 }}>{eyebrow}</p>
          <h1 style={{ margin: "7px 0", fontFamily: "var(--paw-font, system-ui)", fontSize: 30, letterSpacing: "-.035em", color: "var(--paw-link)" }}>{title}</h1>
          <p style={{ color: "var(--paw-muted)", margin: "0 0 20px", lineHeight: 1.6, fontSize: 14 }}>{blurb}</p>
          <div style={{ minHeight: 76, padding: 14, marginBottom: 18, borderRadius: "calc(16px * var(--paw-radius-scale))", border: "1px solid var(--paw-raised)", background: "linear-gradient(135deg,var(--paw-bg),var(--paw-surface))" }}>
            <small style={{ display: "block", fontSize: 9, fontWeight: 900, letterSpacing: 1.3, color: "var(--paw-text)" }}>PAWSPACE PARTNER</small>
            <b style={{ display: "block", marginTop: 4, fontSize: 14 }}>Human care. Clear work. One familiar PawSpace system.</b>
          </div>
          <label style={{ display: "block", fontSize: 12, color: "var(--paw-link)", fontWeight: 700 }}>Booking ID
            <div style={{ display: "flex", gap: 8, marginTop: 7 }}>
              <input value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") open(lookup); }} placeholder={`e.g. ${demoBookingId}`} style={{ flex: 1, minWidth: 0, padding: 12, borderRadius: "calc(11px * var(--paw-radius-scale))", border: "1px solid var(--paw-line)", background: "var(--paw-surface)", color: "var(--paw-link)", boxSizing: "border-box", fontSize: 16 }} />
              <button disabled={!lookup.trim()} onClick={() => open(lookup)} style={{ padding: "12px 18px", borderRadius: "calc(11px * var(--paw-radius-scale))", border: "none", background: lookup.trim() ? "var(--paw-deep)" : "var(--paw-muted)", color: "#fff", fontWeight: 850, cursor: lookup.trim() ? "pointer" : "not-allowed" }}>Open</button>
            </div>
          </label>
          <div style={{ marginTop: 17, padding: "12px 14px", borderRadius: "calc(13px * var(--paw-radius-scale))", background: "var(--paw-surface)", fontSize: 13, lineHeight: 1.5 }}><b>Testing?</b> Open the seeded {demoLabel}: <Link href={`${basePath}?bookingId=${demoBookingId}`} style={{ color: "var(--paw-link)", fontWeight: 800 }}>{demoBookingId} →</Link></div>
          <p style={{ marginTop: 17, fontSize: 12, color: "var(--paw-muted)", lineHeight: 1.6 }}>No booking yet? <Link href={customerHref} style={{ color: "var(--paw-link)", fontWeight: 700 }}>{customerLabel}</Link>. Staff can find booking IDs in <Link href={opsHref} style={{ color: "var(--paw-link)", fontWeight: 700 }}>{opsLabel}</Link>.</p>
        </section>
      </div>
    </main>
  );
}
