"use client";

/**
 * Last-resort boundary: catches failures in the root layout itself, where app/error.tsx cannot run.
 * It must render its own <html> and <body> because the layout that normally provides them is the
 * thing that failed. No imports, no shared components, no design system — anything this file depends
 * on is something that can take the recovery screen down with the page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px 20px",
          background: "var(--paw-surface, #f7faf8)",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <div role="alert" style={{ maxWidth: 460, textAlign: "center" }}>
          <div aria-hidden="true" style={{ fontSize: 40, marginBottom: 14 }}>
            ⌾
          </div>
          <h1 style={{ fontSize: 20, margin: "0 0 8px", color: "var(--paw-primary, #01261F)" }}>
            PawSpace couldn&apos;t start this page
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 20px", color: "var(--paw-text, #18382F)" }}>
            This is unexpected. Reloading usually clears it. If it keeps happening, quote the
            reference below.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "11px 20px",
              borderRadius: "calc(12px * var(--paw-radius-scale, 1))",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              color: "#ffffff",
              background: "var(--paw-deep, #01261F)",
            }}
          >
            Reload
          </button>
          {error.digest ? (
            <p style={{ fontSize: 11, marginTop: 18, color: "var(--paw-muted, #556B63)" }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
