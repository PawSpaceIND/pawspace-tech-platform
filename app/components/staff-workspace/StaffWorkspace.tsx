"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { activeStaffLink, visibleStaffGroups, type StaffActor } from "./navigation";
import styles from "./staff-workspace.module.css";
import {currentNavigationSnapshot, type NavigationSnapshot} from "./display-state";

/** Presentation frame only. Existing page state, API requests and actions remain children. */
export default function StaffWorkspace({ actor: suppliedActor, actorPending = false, children }: {
  actor?: StaffActor | null; actorPending?: boolean; children: ReactNode;
}) {
  const pathname = usePathname() ?? "/team";
  const [navigationSnapshot, setNavigationSnapshot] = useState<NavigationSnapshot<StaffActor> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentNavigation = currentNavigationSnapshot(navigationSnapshot, pathname, attempt);
  const actor = suppliedActor === undefined ? currentNavigation?.actor ?? null : suppliedActor;
  const navigationError = currentNavigation?.error ?? "";
  const signInUrl = currentNavigation?.signInUrl ?? "";
  const active = activeStaffLink(pathname);
  const groups = visibleStaffGroups(actor?.permissions ?? [], query);

  // Home already reads this source. Other migrated pages read it only for their navigation.
  // A failed navigation read never hides a child page or bypasses its existing access checks.
  useEffect(() => {
    if (suppliedActor !== undefined) return;
    const abort = new AbortController();
    let responseStatus = 0, nextSignInUrl = "";
    void fetch("/api/team-overview", { cache: "no-store", signal: abort.signal })
      .then(async response => {
        const body = await response.json() as { data?: { actor?: StaffActor }; error?: string; signInUrl?: string };
        responseStatus = response.status;
        if (!response.ok) {
          nextSignInUrl = body.signInUrl === "/staging-login" ? body.signInUrl : "";
          throw new Error(body.error || "Workspace navigation is unavailable.");
        }
        const next = body.data?.actor;
        if (!next || !Array.isArray(next.permissions) || !next.permissions.every(permission => typeof permission === "string")) {
          throw new Error("Workspace access could not be verified.");
        }
        if (!abort.signal.aborted) setNavigationSnapshot({pathname, attempt, actor: next, error: "", signInUrl: "", status: responseStatus});
      })
      .catch(error => {
        if (!abort.signal.aborted) setNavigationSnapshot({pathname, attempt, actor: null, error: error instanceof Error ? error.message : "Navigation unavailable.", signInUrl: nextSignInUrl, status: responseStatus});
      });
    return () => abort.abort();
  }, [suppliedActor, pathname, attempt]);

  return <div className={styles.frame} data-staff-workspace="true">
    <a href="#staff-workspace-content" className={styles.skip}>Skip to workspace</a>
    <div className={styles.mobileBar}>
      <Link href="/team">PawSpace Team</Link>
      <button type="button" aria-controls="staff-workspace-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(open => !open)}>{mobileOpen ? "Close navigation" : "Open navigation"}</button>
    </div>
    <aside className={`${styles.sidebar} ${mobileOpen ? styles.mobileOpen : ""}`} id="staff-workspace-navigation" aria-label="Team workspace navigation">
      <Link href="/team" className={styles.brand} aria-label="PawSpace Team home"><img src="/brand/pawspace-horizontal.png" width="315" height="89" alt="PawSpace" /></Link>
      <p className={styles.eyebrow}>TEAM WORKSPACE</p>
      <label className={styles.finder}><span>Find a workspace</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search modules" /></label>
      <nav aria-label="Staff workspaces">
        <Link href="/team" className={`${styles.home} ${pathname === "/team" ? styles.selected : ""}`} aria-current={pathname === "/team" ? "page" : undefined}>Home / My work</Link>
        {groups.map(group => <details key={`${group.id}:${pathname}:${Boolean(query)}`} className={styles.group} open={Boolean(query) || group.links.some(link => link.href === active)}>
          <summary>{group.label}</summary>
          <div>{group.links.map(link => <Link key={link.href} href={link.href} className={link.href === active ? styles.selected : ""} aria-current={link.href === active ? "page" : undefined} onClick={() => setMobileOpen(false)}>{link.label}</Link>)}</div>
        </details>)}
      </nav>
      {!actor && <p className={styles.navHint} role="status">{navigationError ? currentNavigation?.status === 403 ? "Your role does not include the Team menu. The current page below keeps its own access checks." : "Navigation unavailable. Your workspace below keeps its existing access checks." : actorPending || suppliedActor === undefined ? "Checking your workspace access..." : "Your role has not been verified."}</p>}
      {!actor && navigationError && pathname === "/me" && <a className={styles.home} href="#staff-workspace-content">Current page: My workspace</a>}
      {actor && groups.length === 0 && <p className={styles.navHint}>{query ? "No permitted workspace matches your search." : "No workspaces enabled for your role."}</p>}
      {navigationError && <div className={styles.navRecovery}><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry navigation</button>{signInUrl && <Link href={signInUrl}>Sign in again</Link>}</div>}
      <div className={styles.sidebarFooter}>
        <p><strong>{actor?.name || "PawSpace Team"}</strong><span>{actor?.roleCode?.replace(/_/g, " ") || "Role-based access"}</span></p>
        <details><summary>Other experiences</summary><Link href="/">Customer home</Link><Link href="/v2">Customer app</Link><Link href="/partner">Partner workspace</Link></details>
      </div>
    </aside>
    <div className={styles.content} id="staff-workspace-content" tabIndex={-1}>{children}</div>
  </div>;
}
