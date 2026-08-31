import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-safe.css";
import "./review-overrides.css";
import "./unified-pawspace-theme.css";
import ReviewUxFixes from "./components/review-ux-fixes";
import OrderNotificationCenter from "./components/order-notification-center";

export const metadata: Metadata = {
  title: "PawSpace — Pet Care Platform",
  description: "Book trusted doorstep pet care across Bengaluru — grooming, boarding, training, sitting, walking, and pet taxi.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#01261F",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ReviewUxFixes />
        {children}
        <OrderNotificationCenter />
      </body>
    </html>
  );
}
