/**
 * PawSpace Mobile Offline Telemetry Queue & Network Resilience Engine
 * Buffers GPS telemetry packets and service media proof in cellular dead zones
 * Automatically flushes to staging-api in sequential order upon network reconnection
 */
import { Preferences } from "@capacitor/preferences";
import { Network, type ConnectionStatus } from "@capacitor/network";
import { Capacitor } from "@capacitor/core";

export interface QueuedTelemetryItem {
  id: string;
  type: "gps_coordinate" | "grooming_photo";
  endpoint: string;
  payload: Record<string, unknown>;
  timestamp: number;
  retryCount: number;
}

const STORAGE_KEY = "pawspace_offline_telemetry_queue";

// In-memory queue fallback for non-native / test environments
let memoryQueue: QueuedTelemetryItem[] = [];
// Serialize read/modify/write operations, but never hold the lock during HTTP.
let mutation: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutation.then(operation);
  mutation = result.catch(() => undefined);
  return result;
}
let activeFlush: Promise<{ flushed: number; remaining: number }> | null = null;

export async function getOfflineQueue(): Promise<QueuedTelemetryItem[]> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      return value ? (JSON.parse(value) as QueuedTelemetryItem[]) : [];
    }
    if (typeof localStorage !== "undefined") {
      const value = localStorage.getItem(STORAGE_KEY);
      return value ? (JSON.parse(value) as QueuedTelemetryItem[]) : [];
    }
  } catch {
    throw new Error("Could not read saved service updates. Please keep PawSpace open and try again.");
  }
  return [...memoryQueue];
}

export async function saveOfflineQueue(items: QueuedTelemetryItem[]): Promise<void> {
  try {
    const serialized = JSON.stringify(items);
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key: STORAGE_KEY, value: serialized });
    } else if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, serialized);
    }
    memoryQueue = [...items];
  } catch {
    throw new Error("Could not save this update on your device. Please reconnect and try again.");
  }
}

export async function enqueueOfflineTelemetry(
  item: Omit<QueuedTelemetryItem, "id" | "timestamp" | "retryCount">
): Promise<QueuedTelemetryItem> {
  const newItem: QueuedTelemetryItem = {
    ...item,
    id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    retryCount: 0,
  };

  const current = await mutate(async () => {
    const items = await getOfflineQueue();
    items.push(newItem);
    await saveOfflineQueue(items);
    return items;
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pawspace:offline-queue-updated", { detail: current.length }));
  }

  return newItem;
}

export function flushOfflineQueue(): Promise<{ flushed: number; remaining: number }> {
  if (!activeFlush) {
    activeFlush = performFlush().finally(() => { activeFlush = null; });
  }
  return activeFlush;
}

async function performFlush(): Promise<{
  flushed: number;
  remaining: number;
}> {
  const queue = await getOfflineQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  console.info(`[PawSpace Offline Queue] Flushing ${queue.length} stored telemetry items...`);

  const delivered = new Set<string>();
  const attempted = new Set<string>();
  let flushedCount = 0;

  // Process items sequentially to prevent server rate-limiting
  for (const item of queue) {
    attempted.add(item.id);
    try {
      const response = await fetch(item.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.payload),
      });

      // A conflict is not proof of delivery. Only an acknowledged success removes data.
      if (response.ok) {
        flushedCount++;
        delivered.add(item.id);
      }
    } catch {
      // Network still failing or unreachable
      // Retain every unacknowledged item, including after repeated failures.
    }
  }

  const remainingItems = await mutate(async () => {
    const latest = await getOfflineQueue();
    const remaining = latest.filter((item) => !delivered.has(item.id)).map((item) =>
      attempted.has(item.id) ? { ...item, retryCount: item.retryCount + 1 } : item
    );
    await saveOfflineQueue(remaining);
    return remaining;
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("pawspace:offline-queue-flushed", {
        detail: { flushed: flushedCount, remaining: remainingItems.length },
      })
    );
  }

  return { flushed: flushedCount, remaining: remainingItems.length };
}

export async function clearOfflineQueue(): Promise<void> {
  await mutate(() => saveOfflineQueue([]));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pawspace:offline-queue-updated", { detail: 0 }));
  }
}

export async function getNetworkStatus(): Promise<ConnectionStatus> {
  if (Capacitor.isNativePlatform()) {
    return Network.getStatus();
  }
  if (typeof navigator !== "undefined" && "onLine" in navigator) {
    return {
      connected: navigator.onLine,
      connectionType: navigator.onLine ? "wifi" : "none",
    };
  }
  return { connected: true, connectionType: "unknown" };
}
