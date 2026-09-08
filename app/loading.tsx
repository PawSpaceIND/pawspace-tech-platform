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
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "3px solid rgba(1,38,31,.15)",
          borderTopColor: "#01261F",
          animation: "ps-spin 900ms linear infinite",
        }}
      />
      <span style={{ fontSize: 13, color: "#5b6b66", fontWeight: 500 }}>
        Getting things ready for your petter half…
      </span>
    </div>
  );
}
