import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-safe.css";
import "./review-overrides.css";
import "./unified-pawspace-theme.css";
import "./prototype-convergence.css";
import ReviewUxFixes from "./components/review-ux-fixes";
import OrderNotificationCenter from "./components/order-notification-center";
import PawSpaceAppearance from "./components/pawspace-appearance";
import CookieConsent from "./components/cookie-consent";
import LegalFooter from "./components/legal-footer";

export const metadata: Metadata = {
  title: "PawSpace — Pet Care Platform",
  description: "Book trusted doorstep pet care across Bengaluru — grooming, boarding, training, sitting, walking, and pet taxi.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#01261F" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="antialiased"><ReviewUxFixes />{children}<LegalFooter /><CookieConsent /><PawSpaceAppearance /><OrderNotificationCenter /></body></html>;
}
