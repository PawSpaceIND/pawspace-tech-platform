import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-safe.css";
import "./review-overrides.css";
import ReviewUxFixes from "./components/review-ux-fixes";

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
  themeColor: "#5d22a8",
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
      </body>
    </html>
  );
}
