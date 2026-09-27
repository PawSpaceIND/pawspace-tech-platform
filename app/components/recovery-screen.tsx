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
  title,
  detail,
  digest,
  onRetry,
  homeHref = "/",
}: {
  title: string;
  detail: string;
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
          "var(--paw-font, system-ui)",
      }}
    >
      <div style={{ maxWidth: 460, width: "100%", textAlign: "center" }}>
        <div aria-hidden="true" style={{ fontSize: 40, lineHeight: 1, marginBottom: 14 }}>
          ⌾
        </div>
        <h1 style={{ fontSize: 20, margin: "0 0 8px", color: "var(--paw-link)" }}>{title}</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 20px", color: "var(--paw-text)" }}>
          {detail}
        </p>
        <div
          style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}
        >
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: "11px 20px",
                borderRadius: "calc(12px * var(--paw-radius-scale))",
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
                color: "#ffffff",
                background: "var(--paw-deep)",
              }}
            >
              Try again
            </button>
          ) : null}
          <Link
            href={homeHref}
            style={{
              padding: "11px 20px",
              borderRadius: "calc(12px * var(--paw-radius-scale))",
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
              color: "var(--paw-link)",
              border: "1px solid var(--paw-line)",
            }}
          >
            Back to home
          </Link>
        </div>
        {/* The digest is the only handle a tester can quote that ties their white screen to a log
            line. Without it a bug report is "it broke on some screen at some time". */}
        {digest ? (
          <p style={{ fontSize: 11, marginTop: 18, color: "var(--paw-muted)" }}>
            Reference: <code>{digest}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
