"use client";
import Link from "next/link";
import VisualAnalytics from "../../components/ui/VisualAnalytics";
import StaffModule from "../../components/staff-workspace/StaffModule";
export default function AnalyticsPage() {
  return <StaffModule><main style={{ minHeight: "100vh", padding: "clamp(12px, 3vw, 28px)", background: "var(--staff-bg)", color: "var(--staff-text)" }}><div style={{ maxWidth: 1400, margin: "0 auto" }}><header><small style={{ color: "var(--staff-primary)", fontWeight: 800 }}>PAWSPACE TEAM · ANALYTICS</small><h1>Company performance</h1><p>Understand what changed, compare services, and explore the bookings behind each result.</p><Link href="/team">Back to team home</Link></header><VisualAnalytics /></div></main></StaffModule>;
}
