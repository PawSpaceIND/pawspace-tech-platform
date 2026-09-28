export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        fontFamily:
          "var(--paw-font, system-ui)",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          border: "3px solid rgba(1,38,31,.15)",
          borderTopColor: "#01261F",
          animation: "ps-spin 900ms linear infinite",
        }}
      />
      <span style={{ fontSize: 13, color: "var(--paw-text)" }}>Loading…</span>
    </div>
  );
}
