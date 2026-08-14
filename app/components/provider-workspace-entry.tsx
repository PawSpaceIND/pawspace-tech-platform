"use client";
import Link from "next/link";
import { useState } from "react";

/**
 * Shared entry screen for the booking-keyed provider workspaces (Walker, Sitter, Driver …). These pages
 * load a single canonical booking from `?bookingId=`; opened without one they used to show a bare,
 * unstyled dead end. This gives them a real front door: paste/lookup a booking ID, one-click into the
 * seeded demo booking, or jump to the customer flow / Operations to find one. (The booking loads only
 * when signed in with access — the provider who owns it, or staff holding bookings.manage.)
 */
export default function ProviderWorkspaceEntry({ eyebrow, title, blurb, basePath, demoBookingId, demoLabel, customerHref, customerLabel, opsHref, opsLabel }: {
  eyebrow: string; title: string; blurb: string; basePath: string;
  demoBookingId: string; demoLabel: string;
  customerHref: string; customerLabel: string; opsHref: string; opsLabel: string;
}) {
  const [lookup, setLookup] = useState("");
  const open = (id: string) => { const trimmed = id.trim(); if (trimmed) window.location.assign(`${basePath}?bookingId=${encodeURIComponent(trimmed)}`); };
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px", fontFamily: "system-ui,-apple-system,Segoe UI,sans-serif", background: "#f7f4fb", color: "#24133f" }}>
      <div style={{ width: "100%", maxWidth: 520, background: "#fff", border: "1px solid #e9e3f1", borderRadius: 16, padding: 26, boxShadow: "0 10px 30px rgba(36,20,54,.06)" }}>
        <p style={{ fontWeight: 800, letterSpacing: 2, color: "#6c39a8", fontSize: 12, margin: 0 }}>{eyebrow}</p>
        <h1 style={{ margin: "6px 0", fontSize: 26 }}>{title}</h1>
        <p style={{ color: "#6b6478", margin: "0 0 18px" }}>{blurb}</p>
        <label style={{ display: "block", fontSize: 13, color: "#6b6478", fontWeight: 600 }}>Booking ID
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") open(lookup); }} placeholder={`e.g. ${demoBookingId}`} style={{ flex: 1, padding: 11, borderRadius: 9, border: "1px solid #e9e3f1", background: "#faf8fc", color: "#24133f", boxSizing: "border-box" }} />
            <button disabled={!lookup.trim()} onClick={() => open(lookup)} style={{ padding: "11px 18px", borderRadius: 10, border: "none", background: lookup.trim() ? "#4b168c" : "#c9bce0", color: "#fff", fontWeight: 700, cursor: lookup.trim() ? "pointer" : "not-allowed" }}>Open</button>
          </div>
        </label>
        <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 12, background: "#f4eefb", fontSize: 14, lineHeight: 1.5 }}><b>Testing?</b> Open the seeded {demoLabel}: <Link href={`${basePath}?bookingId=${demoBookingId}`} style={{ color: "#4b168c", fontWeight: 700 }}>{demoBookingId} →</Link></div>
        <p style={{ marginTop: 16, fontSize: 13, color: "#6b6478" }}>No booking yet? <Link href={customerHref} style={{ color: "#4b168c", fontWeight: 600 }}>{customerLabel}</Link>. Staff can find booking IDs in <Link href={opsHref} style={{ color: "#4b168c", fontWeight: 600 }}>{opsLabel}</Link>.</p>
      </div>
    </main>
  );
}
