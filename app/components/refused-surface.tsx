"use client";
import Link from "next/link";
import type React from "react";
import { useStaffActor, useVisibleStaffLinks, type HubWorkspaceLink } from "./hub-workspace-links";
import { hasPermission, type Permission } from "../../lib/platform-security";

/**
 * A refused read must not render a number.
 *
 * R3-G / F6. Every screen on this platform computes its headline tiles from whatever state it
 * holds, and a failed read leaves that state empty - so `/team/operations/bookings` showed an
 * associate "Total bookings 0 · Needs attention 0 · Payment pending 0 · Open revenue ₹0" directly
 * above "Permission denied", `/team/acquisition-funnel`, `/team/alerts`, `/team/cases`, `/team/ai`
 * and `/team/people/incentives` did the same, and a SIGNED-OUT visitor on /booking-command-center
 * saw the identical four zeros behind a 401. "You may not see this" and "there is nothing today"
 * rendered as the same screen, and only one of them is a fact.
 *
 * Zero is a measurement. A refusal is the absence of one. The rule this file exists to hold is that
 * the two never look alike: when a read fails, the figures computed from the empty state are not
 * rendered at all, and the notice that replaces them says which of the two happened.
 *
 * It is a shared component and not a per-screen fix on purpose - the next screen that adds a KPI row
 * inherits the behaviour by wrapping it, instead of re-deciding it.
 */

/**
 * Whether this failure is a refusal (the actor may not read this) or a fault (the read broke).
 *
 * Matched on the platform's own refusal wording: lib/server-auth.ts answers "Permission denied" and
 * "Authentication required", the gateway answers "Unauthorized", and lib/admin-mfa.ts "MFA required".
 * An unrecognised message is treated as a FAULT, which is the safe direction: both suppress the
 * numbers, and only the wording differs.
 */
export function isAccessRefusal(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  return /permission denied|not authori[sz]ed|unauthori[sz]ed|authentication required|forbidden|mfa required|sign in|403|401|outside the manager|not fully provisioned/.test(text);
}

const box: React.CSSProperties = {
  margin: "0 0 14px", padding: "14px 16px", borderRadius: 12,
  border: "1px solid #e7c9c9", background: "#fff6f6", color: "#7a2020",
  fontSize: 13, lineHeight: 1.5,
};
const strong: React.CSSProperties = { display: "block", fontWeight: 800, fontSize: 14, marginBottom: 4 };
const quiet: React.CSSProperties = { display: "block", marginTop: 6, color: "#8a5a5a" };

/**
 * The notice that stands in place of the suppressed figures. Renders nothing when there is no error,
 * so a screen can place it unconditionally.
 */
export function ReadRefusedNotice({ error, what = "this view" }: { error: string; what?: string }) {
  if (!error) return null;
  const refused = isAccessRefusal(error);
  return (
    <div role="alert" style={box}>
      <strong style={strong}>{refused ? `You do not have access to ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} could not be loaded.`}</strong>
      <span>{error}</span>
      <span style={quiet}>
        {refused
          ? "No figures are shown, because none were read. A zero here would mean “nothing today”, and that is not what happened."
          : "No figures are shown, because none were read. Try again, or ask an admin if this keeps happening."}
      </span>
    </div>
  );
}

/**
 * Renders its children only when the read succeeded.
 *
 * `loading` renders the placeholder rather than the children for the same reason: a tile that shows
 * 0 and then jumps to 41 has already told the operator something false.
 */
export function ReadGate({ error, loading, placeholder, children }: {
  error: string;
  loading?: boolean;
  placeholder?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (error) return null;
  if (loading) return <>{placeholder ?? null}</>;
  return <>{children}</>;
}


/**
 * A whole screen that could not be read.
 *
 * R3-G / F11: /control/integrations and /system-integration answered a refused actor with exactly
 * "Permission denied" plus the legal footer - 309 characters, no heading, no navigation and no way
 * back - for six of the eleven actor profiles. A dead end is not a refusal message; the operator
 * cannot tell whether they lack a permission, typed a wrong URL or hit a broken build, and has
 * nowhere to go next.
 *
 * The ways back are gated by the same filter as every other link list, so this screen cannot repeat
 * the defect it exists to fix by offering a second door that also refuses.
 */
const WAYS_BACK: HubWorkspaceLink[] = [
  { href: "/team", label: "Team workspace", detail: "", permission: "dashboard.view" },
  { href: "/control", label: "Platform Control", detail: "", permission: "audit.view" },
];

const screen: React.CSSProperties = { minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial, Helvetica, sans-serif", color: "#24133f" };
const panel: React.CSSProperties = { maxWidth: 680, margin: "40px auto", background: "white", border: "1px solid #e5dcef", borderRadius: 14, padding: 24 };
const eyebrowStyle: React.CSSProperties = { display: "block", fontWeight: 800, letterSpacing: 1.1, fontSize: 12, color: "#6c39a8" };
const backRow: React.CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 };
const backLink: React.CSSProperties = { display: "inline-block", padding: "9px 14px", borderRadius: 10, border: "1px solid #e5dcef", background: "#faf8fc", color: "#4b168c", textDecoration: "none", fontWeight: 700, fontSize: 13 };

export function RefusedScreen({ eyebrow, title, error, what }: { eyebrow: string; title: string; error: string; what: string }) {
  const waysBack = useVisibleStaffLinks(WAYS_BACK);
  return (
    <main style={screen}>
      <section style={panel}>
        <span style={eyebrowStyle}>{eyebrow}</span>
        <h1 style={{ margin: "6px 0 14px", fontSize: 24 }}>{title}</h1>
        <ReadRefusedNotice error={error} what={what} />
        {waysBack.length > 0
          ? <div style={backRow}>{waysBack.map((link) => <Link key={link.href} href={link.href} style={backLink}>← {link.label}</Link>)}</div>
          : <p style={{ margin: 0, color: "#6d6379", fontSize: 13 }}>Sign in with a staff account that holds this permission, or ask an admin for access.</p>}
      </section>
    </main>
  );
}


/**
 * A workspace whose forms must not be shown to an actor whose writes will be refused.
 *
 * R3-G / F7. Several screens do no read on load - they are a booking-id box plus a set of governed
 * actions - so there is no failed fetch to hang a refusal off, and an associate opening
 * /team/finance/food, /sitting, /taxi, /walking or /team/people/service-incentives got the complete
 * form, SILENTLY, and only found out when a submission came back 403. Offering a form nobody can
 * submit is worse than offering nothing: it costs the operator the work of filling it in before it
 * tells them anything.
 *
 * The permission is the one the workspace's API enforces. Nothing renders before the actor has
 * loaded, for the reason given on useVisibleStaffLinks.
 */
export function StaffPermissionGate({ permission, what, children }: {
  permission: Permission;
  what: string;
  children: React.ReactNode;
}) {
  const { permissions, loaded } = useStaffActor();
  if (!loaded) return <p style={{ margin: 0, color: "#6d6379", fontSize: 13 }}>Checking your access to {what}…</p>;
  if (!hasPermission(permissions, permission)) {
    return <ReadRefusedNotice error={`Permission denied: ${what} needs ${permission}, which your role does not hold.`} what={what} />;
  }
  return <>{children}</>;
}
