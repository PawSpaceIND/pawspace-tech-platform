"use client";

import Link from "next/link";

/**
 * The shared recovery surface behind every error boundary in the app.
 *
 * Before this existed there was not a single error.tsx, loading.tsx or not-found.tsx anywhere under
 * app/ — so any thrown render error produced a white page with no message and no way back. A tester
 * who hit one had no option but to end the session, and no information to report beyond "it went
 * blank". That is the single cheapest thing to fix before putting a human in front of the build.
 *
 * Deliberately dependency-free and inline-styled: a boundary that imports the design system can fail
 * for the same reason the page under it failed.
 */
export default function RecoveryScreen({
  title = "Our servers are taking a quick walk. We're on it.",
  detail = "Something took an unexpected pause. Your bookings, pets, and payments are safe — trying again usually gets everything right back on track.",
  digest,
  onRetry,
  homeHref = "/",
}: {
  title?: string;
  detail?: string;
  digest?: string;
  onRetry?: () => void;
  homeHref?: string;
}) {
  return (
    <div
      role="alert"
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ maxWidth: 480, width: "100%", textAlign: "center" }}>
        <div
          aria-hidden="true"
          style={{
            width: 56,
            height: 56,
            borderRadius: "28px",
            background: "#eef6f3",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            marginBottom: 16,
            boxShadow: "0 2px 8px rgba(1,38,31,0.06)",
          }}
        >
          🐾
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "1.2px",
            textTransform: "uppercase",
            color: "#01261F",
            marginBottom: 8,
            opacity: 0.8,
          }}
        >
          PawSpace · Your Petter Half
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 10px", color: "#06231c" }}>{title}</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 24px", color: "#5b6b66" }}>
          {detail}
        </p>
        <div
          style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
        >
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: "12px 22px",
                borderRadius: 12,
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
                color: "#ffffff",
                background: "#01261F",
                boxShadow: "0 2px 8px rgba(1,38,31,0.2)",
                transition: "all 0.2s ease",
              }}
            >
              Try again
            </button>
          ) : null}
          <Link
            href={homeHref}
            style={{
              padding: "12px 22px",
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
              color: "#06231c",
              border: "1px solid #d5ded9",
              background: "#ffffff",
              transition: "all 0.2s ease",
            }}
          >
            Back to home
          </Link>
        </div>
        {digest ? (
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #eef2f0" }}>
            <p style={{ fontSize: 12, margin: 0, color: "#8a9a95" }}>
              Need support? Quote Reference:{" "}
              <code
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11,
                  background: "#f1f5f3",
                  padding: "2px 6px",
                  borderRadius: 4,
                  color: "#01261F",
                }}
              >
                {digest}
              </code>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
