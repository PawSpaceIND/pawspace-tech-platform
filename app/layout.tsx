import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import "./mobile-safe.css";
import "./review-overrides.css";
import "./unified-pawspace-theme.css";
import "./brand-lock.css";
import "./prototype-convergence.css";
import "./mascot-polish.css";
import "./brand-book-theme.css";
import "./pawspace-design-system.css";
import ReviewUxFixes from "./components/review-ux-fixes";
import OrderNotificationCenter from "./components/order-notification-center";
import PawSpaceAppearance from "./components/pawspace-appearance";
import CookieConsent from "./components/cookie-consent";
import LegalFooter from "./components/legal-footer";
import { APPEARANCE_COOKIE } from "./components/appearance-resolver";
import { resolveRootAppearance, resolveTrustedOrigin } from "./components/appearance-root";
import { resolveRequestAppearance } from "../lib/appearance-preferences";
import { database } from "../lib/server-auth";
import { AppearanceProvider } from "./components/appearance-context";

export const metadata: Metadata = {
  title: "PawSpace — Pet Care Platform",
  description: "Book trusted doorstep pet care across Bengaluru — grooming, boarding, training, sitting, walking, and pet taxi.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#164A3D" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The device appearance record is resolved here so the first themed HTML and the client controller share one snapshot.
  // An authoritative account record (customer or provider platform session) wins over the device cookie; staff and
  // signed-out requests keep the device record. The root never writes cookies; a database acquisition failure falls back
  // to the existing device resolution. The request handed to the backend helper carries the cookie store and the request origin.
  const store = await cookies();
  const requestHeaders = await headers();
  // Documented trusted origin: PAWSPACE_PUBLIC_ORIGIN from the Workers env; the host header counts only for the development preview hosts.
  const trustedOrigin = async () => { let configured: unknown; try { const { env } = await import("cloudflare:workers"); configured = (env as unknown as Record<string, unknown>).PAWSPACE_PUBLIC_ORIGIN; } catch { configured = undefined; } return resolveTrustedOrigin({ configured, host: requestHeaders.get("host") }); };
  const root = await resolveRootAppearance({ cookieValue: store.get(APPEARANCE_COOKIE)?.value, cookieHeader: store.toString(), trustedOrigin, acquireDb: database, resolveRequestAppearance });
  const appearance = root.snapshot;
  const accountHint = { recordVersion: root.recordVersion, accountAuthoritative: root.accountAuthoritative };
  return <html lang="en" data-paw-theme={appearance.effective} data-paw-mode={appearance.mode} data-paw-style="professional"><body className="antialiased"><AppearanceProvider initial={appearance}><ReviewUxFixes />{children}<LegalFooter /><CookieConsent /><PawSpaceAppearance initial={appearance} account={accountHint} /><OrderNotificationCenter /></AppearanceProvider></body></html>;
}
