"use client";
import Link from "next/link";
import { useState } from "react";
import TrainingPanel from "../../../admin/training-panel";

/**
 * Training Operations — session recovery, trainer replacement and payment records.
 *
 * The panel itself is real (it reads /api/training-ops and the canonical programme session records)
 * and is owned by /admin, which now reads the database too. This route mounts the same component so
 * Training sits alongside the other per-vertical Operations workspaces, where the ops team works —
 * one implementation, two entry points, no copy of the logic.
 */
export default function TrainingOperationsPage() {
  const [toast, setToast] = useState("");
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2400); };
  return (
    <main style={{ minHeight: "100vh", background: "#f7f4fb", padding: 28, fontFamily: "Arial,sans-serif", color: "#24133f" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 18 }}>
          <div>
            <small style={{ fontWeight: 800, color: "#6c39a8" }}>PAWSPACE TEAM · OPERATIONS · TRAINING</small>
            <h1 style={{ margin: "7px 0" }}>Training operations</h1>
            <p style={{ margin: 0, color: "#746b7d" }}>Session recovery, trainer replacement and canonical payment records.</p>
          </div>
          <Link href="/team/operations" style={{ padding: 10, background: "#4b168c", color: "white", borderRadius: 10, textDecoration: "none" }}>← Operations</Link>
        </header>
        <TrainingPanel notify={notify} />
        {toast && <p role="status" style={{ marginTop: 14, color: "#6c39a8", fontWeight: 700 }}>✓ {toast}</p>}
      </div>
    </main>
  );
}
