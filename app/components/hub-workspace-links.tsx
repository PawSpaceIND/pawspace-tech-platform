"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { defaultRoles, hasPermission, type Permission } from "../../lib/platform-security";

/**
 * The permission-filtered link list a hub page shows for the workspaces it owns.
 *
 * 45 of the 153 screens on this platform were not linked from anywhere in app/, lib/ or worker/:
 * they rendered, they had tests, and the only way to reach one was to type its URL. The single
 * clearest case was Team Finance, which linked two of its ten sibling finance screens.
 *
 * A hub therefore needs one shape for "here are the workspaces under me", and it has to be gated:
 * offering a link whose screen answers "Permission denied" is worse than not offering it, because
 * the operator cannot tell a missing permission from a broken page. The gate is the same one
 * app/control/page.tsx uses for its nav - hasPermission(actorPermissions, item.permission) - and
 * `permission` on each entry is the permission the DESTINATION's API actually demands to load,
 * read off that route, never a convenient wider one.
 */
export type HubWorkspaceLink = { href: string; label: string; detail: string; permission: Permission };

/**
 * The entries this actor may open. Exported so a test can run the filter without a renderer.
 *
 * Generic over the entry shape rather than fixed to HubWorkspaceLink: the same gate now runs the
 * Operations rail in app/components/ops-shell/OpsShell.tsx, whose items carry an icon and a badge
 * instead of a detail line. Only `permission` is read, so widening the type adds no behaviour - it
 * stops the rail needing a third copy of a filter that already exists twice.
 */
export function visibleHubLinks<T extends { permission: Permission }>(permissions: string[], links: readonly T[]): T[] {
  return links.filter((link) => hasPermission(permissions, link.permission));
}

const section: React.CSSProperties = { margin: "22px 0 0", padding: 18, background: "white", border: "1px solid #e5dcef", borderRadius: 14 };
const eyebrow: React.CSSProperties = { display: "block", fontWeight: 800, letterSpacing: 1.1, fontSize: 12, color: "#6c39a8" };
const headingStyle: React.CSSProperties = { margin: "6px 0 2px", fontSize: 20, color: "#24133f" };
const noteStyle: React.CSSProperties = { margin: "0 0 14px", color: "#6d6379", fontSize: 13, lineHeight: 1.5 };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 10 };
const card: React.CSSProperties = { display: "block", padding: 14, borderRadius: 12, border: "1px solid #e5dcef", background: "#faf8fc", textDecoration: "none", color: "#24133f" };
const cardLabel: React.CSSProperties = { display: "block", fontWeight: 700 };
const cardDetail: React.CSSProperties = { display: "block", marginTop: 5, fontSize: 13, lineHeight: 1.45, color: "#6d6379" };
const cue: React.CSSProperties = { display: "block", marginTop: 8, fontSize: 12, fontWeight: 700, color: "#4b168c" };
const muted: React.CSSProperties = { margin: 0, color: "#6d6379", fontSize: 13 };

/**
 * Presentational and pure: given a permission set it renders exactly the links that set allows.
 * Until the actor has loaded, nothing is offered - a tile shown and then withdrawn reads as a
 * permission that was just taken away.
 */
export function HubWorkspaceLinks({ heading, note, links, permissions, loaded }: {
  heading: string;
  note?: string;
  links: readonly HubWorkspaceLink[];
  permissions: string[];
  loaded: boolean;
}) {
  // `loaded` is the only gate on showing anything: a second guard here would be redundant, and a
  // redundant guard is one nobody can tell is load-bearing.
  const visible = visibleHubLinks(permissions, links);
  return (
    <section style={section} aria-label={heading}>
      <span style={eyebrow}>WORKSPACES UNDER THIS HUB</span>
      <h2 style={headingStyle}>{heading}</h2>
      {note ? <p style={noteStyle}>{note}</p> : null}
      {!loaded
        ? <p style={muted}>Loading what your role can open…</p>
        : visible.length === 0
          ? <p style={muted}>Your role cannot open any of these workspaces. Ask an admin if you need access.</p>
          : <div style={grid}>
            {visible.map((link) => (
              <Link key={link.href} href={link.href} style={card}>
                <strong style={cardLabel}>{link.label}</strong>
                <span style={cardDetail}>{link.detail}</span>
                <span style={cue}>Open →</span>
              </Link>
            ))}
          </div>}
    </section>
  );
}

type Access = { permissions: string[]; loaded: boolean };
export type StaffActor = { name: string; email: string; roleCode: string; permissions: string[] };
type ActorAccess = { actor: StaffActor | null; permissions: string[]; loaded: boolean };

/**
 * The signed-in staff actor, from the same endpoint app/control/page.tsx reads. A failure resolves
 * to no actor and no permissions rather than to an error: the hub's own content still renders, and
 * no link is offered that the actor has not been shown to hold.
 */
export function useStaffActor(): ActorAccess {
  const [state, setState] = useState<ActorAccess>({ actor: null, permissions: [], loaded: false });
  useEffect(() => {
    let active = true;
    void fetch("/api/team-overview", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: { actor?: Partial<StaffActor> } };
        const actor = response.ok && body.data?.actor
          ? { name: String(body.data.actor.name ?? ""), email: String(body.data.actor.email ?? ""), roleCode: String(body.data.actor.roleCode ?? ""), permissions: body.data.actor.permissions ?? [] }
          : null;
        if (active) setState({ actor, permissions: actor?.permissions ?? [], loaded: true });
      })
      .catch(() => { if (active) setState({ actor: null, permissions: [], loaded: true }); });
    return () => { active = false; };
  }, []);
  return state;
}

/** Staff permissions only - the shape every hub gate has used. */
export function useStaffPermissions(): Access {
  const { permissions, loaded } = useStaffActor();
  return { permissions, loaded };
}

/**
 * The entries of `links` this actor may open, loaded once for the whole list.
 *
 * R3-G / F4: the OpsShell RAIL was gated but six page BODIES still carried hardcoded link lists, and
 * between them they offered 60 distinct page-link-403 combinations - /team/operations alone offered
 * six `bookings.manage` queues to associate, provider, customer and a signed-out visitor, directly
 * above a section that says "Only the workspaces your role can open are listed". This is the same
 * gate as HubWorkspaceLinks, in the shape a nav, a sidebar or a footer needs: one actor load, N
 * links. Nothing is offered before the actor has loaded, because a link shown and then withdrawn
 * reads as a permission that was just taken away.
 */
export function useVisibleStaffLinks<T extends { permission: Permission }>(links: readonly T[]): T[] {
  const { permissions, loaded } = useStaffActor();
  return loaded ? visibleHubLinks(permissions, links) : [];
}

/**
 * One permission-gated link, for a single control that is neither a card nor part of a list: a hero
 * call to action, or the "back to the hub" cue a child screen shows. It renders nothing at all when
 * the actor may not open the destination - offering a link whose screen answers "Permission denied"
 * is worse than not offering it, because the operator cannot tell a missing permission from a
 * broken page.
 */
export function StaffGatedLink({ href, permission, className, style, children }: {
  href: string;
  permission: Permission;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { permissions, loaded } = useStaffActor();
  if (!loaded || !hasPermission(permissions, permission)) return null;
  return <Link href={href} className={className} style={style}>{children}</Link>;
}

/**
 * Provider permissions. A partner has an identity session, not a staff account, so /api/team-overview
 * (dashboard.view) refuses it. lib/platform-session.ts derives a session's permissions from the
 * role definition by code; this reads the same definitions for the same role, so the hub cannot
 * offer a partner a link the session would be refused.
 */
export function useProviderPermissions(): Access {
  const [state, setState] = useState<Access>({ permissions: [], loaded: false });
  useEffect(() => {
    let active = true;
    void fetch("/api/identity-session", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: { roleCode?: string } };
        const role = response.ok ? defaultRoles.find((item) => item.code === body.data?.roleCode) : undefined;
        if (active) setState({ permissions: role ? [...role.permissions] : [], loaded: true });
      })
      .catch(() => { if (active) setState({ permissions: [], loaded: true }); });
    return () => { active = false; };
  }, []);
  return state;
}

/** The staff hub form: loads the signed-in staff actor and renders what that role can open. */
export default function StaffHubWorkspaceLinks({ heading, note, links }: { heading: string; note?: string; links: readonly HubWorkspaceLink[] }) {
  const access = useStaffPermissions();
  return <HubWorkspaceLinks heading={heading} note={note} links={links} permissions={access.permissions} loaded={access.loaded} />;
}

/** The partner hub form: the same list, gated on the verified provider identity session. */
export function ProviderHubWorkspaceLinks({ heading, note, links }: { heading: string; note?: string; links: readonly HubWorkspaceLink[] }) {
  const access = useProviderPermissions();
  return <HubWorkspaceLinks heading={heading} note={note} links={links} permissions={access.permissions} loaded={access.loaded} />;
}
