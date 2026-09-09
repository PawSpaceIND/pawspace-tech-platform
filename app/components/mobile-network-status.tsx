"use client";

import { useEffect, useState } from "react";
import { Network, type ConnectionStatus } from "@capacitor/network";
import { Capacitor } from "@capacitor/core";
import {
  getNetworkStatus,
  getOfflineQueue,
  flushOfflineQueue,
} from "../../lib/mobile/offline-queue";

export default function MobileNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [reconnectedMessage, setReconnectedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let isMounted = true;
    let listenerHandle: { remove: () => Promise<void> } | null = null;
    let cleanupWebListeners: (() => void) | null = null;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    const reportSyncIssue = () => {
      if (isMounted) setReconnectedMessage("We couldn't sync your care updates yet. Please keep PawSpace open and try reconnecting.");
    };

    // Check initial queue count and network status
    void getOfflineQueue().then((q) => {
      if (isMounted) setQueuedCount(q.length);
    }).catch(reportSyncIssue);

    void getNetworkStatus().then((status) => {
      if (isMounted) setIsOnline(status.connected);
    }).catch(reportSyncIssue);

    const initNetworkWatcher = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          listenerHandle = await Network.addListener("networkStatusChange", (status: ConnectionStatus) => {
            if (!isMounted) return;
            handleStatusChange(status.connected);
          });
          if (!isMounted) await listenerHandle.remove();
        } else {
          // Web fallback with explicit listener references for safe teardown
          const onOnline = () => handleStatusChange(true);
          const onOffline = () => handleStatusChange(false);
          window.addEventListener("online", onOnline);
          window.addEventListener("offline", onOffline);

          cleanupWebListeners = () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
          };
        }
      } catch (err) {
        console.warn("[PawSpace Network] Failed to initialize Network listener:", err);
      }
    };

    const handleStatusChange = (connected: boolean) => {
      if (!isMounted) return;
      setIsOnline(connected);
      if (connected) {
        // Automatic reconnection flush
        console.info("[PawSpace Network] Reconnected. Triggering automatic offline queue flush...");
        void flushOfflineQueue().then(({ flushed, remaining }) => {
          if (!isMounted) return;
          setQueuedCount(remaining);
          if (flushed > 0) {
            setReconnectedMessage(
              remaining > 0
                ? `Back online. ${flushed} care updates sent; ${remaining} still waiting to sync.`
                : `Back online. Your ${flushed} saved care update${flushed > 1 ? "s are" : " is"} synced. Your Petter half, back in touch.`
            );
            clearTimeout(messageTimer);
            messageTimer = setTimeout(() => {
              if (isMounted) setReconnectedMessage(null);
            }, 4500);
          } else if (remaining > 0) reportSyncIssue();
        }).catch(reportSyncIssue);
      }
    };

    void initNetworkWatcher();

    // Listen for queue updates
    const onQueueUpdated = (e: Event) => {
      const count = (e as CustomEvent<number>).detail ?? 0;
      if (isMounted) setQueuedCount(count);
    };

    const onQueueFlushed = (e: Event) => {
      const detail = (e as CustomEvent<{ flushed: number; remaining: number }>).detail;
      if (isMounted && detail) setQueuedCount(detail.remaining);
    };

    window.addEventListener("pawspace:offline-queue-updated", onQueueUpdated);
    window.addEventListener("pawspace:offline-queue-flushed", onQueueFlushed);

    return () => {
      isMounted = false;
      clearTimeout(messageTimer);
      if (listenerHandle) {
        void listenerHandle.remove().catch(() => undefined);
      }
      if (cleanupWebListeners) {
        cleanupWebListeners();
      }
      window.removeEventListener("pawspace:offline-queue-updated", onQueueUpdated);
      window.removeEventListener("pawspace:offline-queue-flushed", onQueueFlushed);
    };
  }, []);

  const showOffline = !isOnline;
  const showReconnected = Boolean(isOnline && reconnectedMessage);
  const isVisible = showOffline || showReconnected;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        transform: isVisible ? "translateY(0)" : "translateY(-100%)",
        opacity: isVisible ? 1 : 0,
        pointerEvents: isVisible ? "auto" : "none",
        transition: "transform 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease",
        background: showOffline ? "#8a3100" : "#01261F",
        color: "#ffffff",
        padding: "10px 16px",
        textAlign: "center",
        fontSize: "14px",
        fontWeight: 600,
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {showOffline && (
        <>
          <span style={{ fontSize: "14px" }}>📡</span>
          <span>{"You're offline. Care updates saved on this device will retry when you're connected. Please keep PawSpace open."}</span>
          {queuedCount > 0 && (
            <span
              style={{
                background: "rgba(0,0,0,0.28)",
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "0.2px",
              }}
            >
              {queuedCount} pending sync
            </span>
          )}
        </>
      )}
      {showReconnected && (
        <>
          <span style={{ fontSize: "14px" }}>🐾</span>
          <span>{reconnectedMessage}</span>
        </>
      )}
    </div>
  );
}
