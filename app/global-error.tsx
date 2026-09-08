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
          background: "#f7faf8",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <div role="alert" style={{ maxWidth: 480, textAlign: "center" }}>
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
              margin: "0 auto 16px",
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
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 10px", color: "#06231c" }}>
            Our servers are taking a quick walk. We&apos;re on it.
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 24px", color: "#5b6b66" }}>
            PawSpace is taking a quick breath. Please reload to try again. If you were paying, check your booking before making another payment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "12px 24px",
              borderRadius: 12,
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              color: "#ffffff",
              background: "#01261F",
              boxShadow: "0 2px 8px rgba(1,38,31,0.2)",
            }}
          >
            Reload
          </button>
          {error.digest ? (
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #eef2f0" }}>
              <p style={{ fontSize: 12, margin: 0, color: "#8a9a95" }}>
                Need support? Quote Reference:{" "}
                <code
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 11,
                    background: "#eef2f0",
                    padding: "2px 6px",
                    borderRadius: 4,
                    color: "#01261F",
                  }}
                >
                  {error.digest}
                </code>
              </p>
            </div>
          ) : null}
        </div>
      </body>
    </html>
  );
}
