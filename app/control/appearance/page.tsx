"use client";
import Link from "next/link";
import AppearancePlatformPanel from "../appearance-platform-panel";

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  padding: "28px 24px 80px",
  background: "#F4F1EA",
  color: "#1A1A1A",
  fontFamily: "Nunito, ui-sans-serif, system-ui, sans-serif",
  boxSizing: "border-box",
};
const wrap: React.CSSProperties = { maxWidth: 880, margin: "0 auto" };
const crumb: React.CSSProperties = { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20, fontSize: 14 };
const title: React.CSSProperties = { fontSize: 28, lineHeight: 1.2, margin: "0 0 8px", color: "#01261F" };
const lead: React.CSSProperties = { fontSize: 16, lineHeight: 1.5, margin: "0 0 24px", color: "#3D4A46", maxWidth: 640 };

export default function ControlAppearancePage() {
  return (
    <main style={page}>
      <div style={wrap}>
        <nav style={crumb} aria-label="Control">
          <Link href="/control" style={{ color: "#01261F", fontWeight: 700 }}>Control tower</Link>
          <Link href="/mobile-app" style={{ color: "#01261F" }}>Customer app</Link>
          <Link href="/crm" style={{ color: "#01261F" }}>CRM</Link>
          <Link href="/partner-app" style={{ color: "#01261F" }}>Partner app</Link>
        </nav>
        <h1 style={title}>Platform appearance</h1>
        <p style={lead}>Choose the default colour kit for this browser. Same tokens as the customer app. Does not change booking or payment logic.</p>
        <AppearancePlatformPanel notify={(message) => window.alert(message)} />
      </div>
    </main>
  );
}
