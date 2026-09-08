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
    // Fall back to memory queue on storage failure
  }
  return [...memoryQueue];
}

export async function saveOfflineQueue(items: QueuedTelemetryItem[]): Promise<void> {
  memoryQueue = [...items];
  try {
    const serialized = JSON.stringify(items);
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key: STORAGE_KEY, value: serialized });
    } else if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // Ignored in restricted environments
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

  const current = await getOfflineQueue();
  current.push(newItem);
  await saveOfflineQueue(current);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pawspace:offline-queue-updated", { detail: current.length }));
  }

  return newItem;
}

export async function flushOfflineQueue(): Promise<{
  flushed: number;
  remaining: number;
}> {
  const queue = await getOfflineQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  console.info(`[PawSpace Offline Queue] Flushing ${queue.length} stored telemetry items...`);

  const remainingItems: QueuedTelemetryItem[] = [];
  let flushedCount = 0;

  // Process items sequentially to prevent server rate-limiting
  for (const item of queue) {
    try {
      const response = await fetch(item.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.payload),
      });

      // 2xx success or 409 conflict/already processed counts as completed
      if (response.ok || response.status === 409) {
        flushedCount++;
      } else {
        item.retryCount += 1;
        if (item.retryCount < 5) {
          remainingItems.push(item);
        }
      }
    } catch {
      // Network still failing or unreachable
      item.retryCount += 1;
      if (item.retryCount < 5) {
        remainingItems.push(item);
      }
    }
  }

  await saveOfflineQueue(remainingItems);

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
  await saveOfflineQueue([]);
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
