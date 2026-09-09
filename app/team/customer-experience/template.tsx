"use client";

import { useEffect, type ReactNode } from "react";
import { subscribeConversationRefresh } from "../../../lib/conversation-live-refresh";

export default function CustomerExperienceLiveTemplate({ children }: { children: ReactNode }) {
  useEffect(() => {
    // The page owns draft, selection and retry state. Notify it to refresh its data
    // without remounting it. subscribeConversationRefresh dedupes by stream version
    // and re-refreshes after a reconnect; the page keeps its polling fallback.
    if (typeof EventSource === "undefined") return;
    return subscribeConversationRefresh(() => window.dispatchEvent(new Event("pawspace:conversation-refresh")));
  }, []);
  return <div>{children}</div>;
}
