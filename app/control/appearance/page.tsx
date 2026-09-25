"use client";
import Link from "next/link";
import AppearancePlatformPanel from "../appearance-platform-panel";
import StaffModule from "../../components/staff-workspace/StaffModule";

const page: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  padding: "28px 24px 80px",
  background: "var(--staff-bg, #F4F1EA)",
  color: "var(--staff-text, #1A1A1A)",
  fontFamily: "var(--staff-font, Nunito, ui-sans-serif, system-ui, sans-serif)",
  boxSizing: "border-box",
};
const wrap: React.CSSProperties = { maxWidth: 880, margin: "0 auto" };
const crumb: React.CSSProperties = { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20, fontSize: 14 };
const title: React.CSSProperties = { fontSize: 28, lineHeight: 1.2, margin: "0 0 8px", color: "var(--staff-primary, #01261F)" };
const lead: React.CSSProperties = { fontSize: 16, lineHeight: 1.5, margin: "0 0 24px", color: "var(--staff-muted, #3D4A46)", maxWidth: 640 };

export default function ControlAppearancePage() {
  return (
    <StaffModule><main style={page}>
      <div style={wrap}>
        <nav style={crumb} aria-label="Control">
          <Link href="/control" style={{ color: "var(--staff-primary, #01261F)", fontWeight: 700 }}>Control tower</Link>
          <Link href="/mobile-app" style={{ color: "var(--staff-primary, #01261F)" }}>Customer app</Link>
          <Link href="/crm" style={{ color: "var(--staff-primary, #01261F)" }}>CRM</Link>
          <Link href="/partner-app" style={{ color: "var(--staff-primary, #01261F)" }}>Partner app</Link>
        </nav>
        <h1 style={title}>Platform appearance</h1>
        <p style={lead}>Choose the default colour kit for this browser. Same tokens as the customer app. Does not change booking or payment logic.</p>
        <AppearancePlatformPanel notify={(message) => window.alert(message)} />
      </div>
    </main></StaffModule>
  );
}
