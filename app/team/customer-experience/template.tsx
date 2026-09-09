"use client";

import { useEffect, type ReactNode } from "react";

export default function CustomerExperienceLiveTemplate({ children }: { children: ReactNode }) {
  useEffect(() => {
    // The page owns draft and retry state. Refresh its data without remounting it.
    // Its periodic polling continues when EventSource is absent or disconnected.
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/conversations/stream");
    const refresh = () => window.dispatchEvent(new Event("pawspace:conversation-refresh"));
    source.addEventListener("conversation", refresh);
    return () => { source.removeEventListener("conversation", refresh); source.close(); };
  }, []);
  return <>{children}</>;
}
