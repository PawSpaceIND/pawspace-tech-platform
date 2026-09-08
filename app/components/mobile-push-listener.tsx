"use client";

import { useEffect, useState } from "react";
import {
  PushNotifications,
  type Token,
  type PushNotificationSchema,
  type ActionPerformed,
} from "@capacitor/push-notifications";
import { Capacitor } from "@capacitor/core";

export interface MobilePushNotificationPayload {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

export default function MobilePushListener() {
  const [fcmToken, setFcmToken] = useState<string | null>(null);
  const [activeToast, setActiveToast] = useState<MobilePushNotificationPayload | null>(null);

  useEffect(() => {
    // Only execute native push notification registration on native Capacitor platforms (iOS/Android)
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return;
    }

    let isMounted = true;
    const cleanups: Array<() => void> = [];

    const initializePush = async () => {
      try {
        // 1. Request Push Permissions
        const permStatus = await PushNotifications.requestPermissions();
        if (permStatus.receive !== "granted") {
          console.warn("[PawSpace Mobile Push] Push notification permission not granted:", permStatus.receive);
          return;
        }

        // 2. Add Registration Listener
        const regHandle = await PushNotifications.addListener("registration", (token: Token) => {
          if (!isMounted) return;
          console.info("[PawSpace Mobile Push] Registered with FCM token:", token.value);
          setFcmToken(token.value);
          try {
            localStorage.setItem("pawspace_fcm_token", token.value);
            window.dispatchEvent(new CustomEvent("pawspace:fcm-token", { detail: token.value }));
          } catch {
            // localStorage may be unavailable or restricted
          }
        });
        cleanups.push(() => regHandle.remove());

        // 3. Add Registration Error Listener
        const regErrHandle = await PushNotifications.addListener("registrationError", (err: { error: string }) => {
          console.error("[PawSpace Mobile Push] Registration error:", err.error);
        });
        cleanups.push(() => regErrHandle.remove());

        // 4. Add Foreground Notification Received Listener
        const notifHandle = await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification: PushNotificationSchema) => {
            if (!isMounted) return;
            console.info("[PawSpace Mobile Push] Foreground notification received:", notification);
            setActiveToast({
              title: notification.title || "PawSpace Update",
              body: notification.body || "",
              data: notification.data as Record<string, unknown> | undefined,
            });

            // Dispatch global event for order notification centers or customer views
            window.dispatchEvent(
              new CustomEvent("pawspace:notification-received", { detail: notification })
            );
          }
        );
        cleanups.push(() => notifHandle.remove());

        // 5. Add Notification Click / Action Performed Listener
        const actionHandle = await PushNotifications.addListener(
          "pushNotificationActionPerformed",
          (action: ActionPerformed) => {
            if (!isMounted) return;
            console.info("[PawSpace Mobile Push] Notification clicked:", action);
            const data = (action.notification.data || {}) as Record<string, unknown>;
            const targetUrl = typeof data.url === "string" ? data.url : typeof data.route === "string" ? data.route : null;

            if (targetUrl && targetUrl.startsWith("/")) {
              window.location.assign(targetUrl);
            } else if (data.bookingId) {
              window.location.assign(`/assisted-booking?bookingId=${encodeURIComponent(String(data.bookingId))}`);
            }
          }
        );
        cleanups.push(() => actionHandle.remove());

        // 6. Register with APNs / FCM via Capacitor plugin
        await PushNotifications.register();
      } catch (err: unknown) {
        console.warn("[PawSpace Mobile Push] Push notification setup failed:", err);
      }
    };

    void initializePush();

    return () => {
      isMounted = false;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, []);

  // Auto-dismiss in-app notification toast after 6 seconds
  useEffect(() => {
    if (!activeToast) return;
    const timer = setTimeout(() => {
      setActiveToast(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [activeToast]);

  if (!activeToast) {
    return null;
  }

  return (
    <aside
      role="alert"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 20,
        left: 20,
        right: 20,
        maxWidth: 420,
        margin: "0 auto",
        zIndex: 9999,
        background: "#01261F",
        color: "#ffffff",
        border: "1px solid rgba(255, 255, 255, 0.15)",
        borderRadius: 14,
        padding: "14px 16px",
        boxShadow: "0 12px 36px rgba(0, 0, 0, 0.28)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
      onClick={() => {
        const url = typeof activeToast.data?.url === "string" ? activeToast.data.url : null;
        if (url && url.startsWith("/")) {
          window.location.assign(url);
        }
        setActiveToast(null);
      }}
    >
      <div style={{ fontSize: 20 }}>🐾</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#e2f8f0" }}>
          {activeToast.title}
        </strong>
        <p style={{ margin: "3px 0 0", fontSize: 12, color: "#c8e6dc", lineHeight: 1.4 }}>
          {activeToast.body}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          setActiveToast(null);
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "#a3c2b8",
          fontSize: 16,
          cursor: "pointer",
          padding: 2,
        }}
      >
        ×
      </button>
    </aside>
  );
}
