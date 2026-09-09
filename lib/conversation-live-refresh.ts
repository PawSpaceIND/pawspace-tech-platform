/** Stream versions invalidate inbox data; they must never remount the editor. */
type Source = Pick<EventSource, "addEventListener" | "close">;
export function subscribeConversationRefresh(refresh: () => void, createSource: () => Source = () => new EventSource("/api/conversations/stream")) {
  const source = createSource();
  let closed = false;
  let lastVersion = -1;
  const receive = (event: Event) => {
    if (closed) return;
    let version: number;
    try { version = JSON.parse((event as MessageEvent).data).version; } catch { return; }
    if (!Number.isSafeInteger(version) || version < 0) return;
    // Every ready event starts a new connection. Refresh even if the server clock went backwards;
    // data may have changed during disconnection. Conversation replays within a connection dedupe.
    if (event.type !== "ready" && version <= lastVersion) return;
    lastVersion = version;
    refresh();
  };
  source.addEventListener("ready", receive);
  source.addEventListener("conversation", receive);
  // The page retains its bounded polling fallback throughout a network interruption.
  return () => { closed = true; source.close(); };
}
