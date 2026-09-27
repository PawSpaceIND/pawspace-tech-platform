/** One transcript read at a time. A deadline frees the poll after network failure; cleanup aborts it. */
export function createTranscriptPoll(read: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 10000) {
  let active = true;
  let current: AbortController | null = null;
  return {
    async tick() {
      if (!active || current) return;
      const controller = new AbortController();
      current = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { await read(controller.signal); }
      catch { /* The next scheduled poll retries; sending messages has its own visible error state. */ }
      finally { clearTimeout(timer); if (current === controller) current = null; }
    },
    stop() { active = false; current?.abort(); },
  };
}
