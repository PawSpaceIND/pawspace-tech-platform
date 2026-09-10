import {
  PushNotifications,
  type Token,
  type PushNotificationSchema,
  type ActionPerformed,
} from "@capacitor/push-notifications";
import { Capacitor } from "@capacitor/core";

export interface PushNotificationHandlers {
  onToken?: (token: string) => void;
  onRegistrationError?: (error: string) => void;
  onNotificationReceived?: (notification: PushNotificationSchema) => void;
  onActionPerformed?: (action: ActionPerformed) => void;
}

export async function checkPushPermissions(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const status = await PushNotifications.checkPermissions();
    return status.receive === "granted";
  } catch {
    return false;
  }
}

export async function requestPushPermissions(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const status = await PushNotifications.requestPermissions();
    return status.receive === "granted";
  } catch {
    return false;
  }
}

export async function registerForPushNotifications(): Promise<{
  registered: boolean;
  token?: string;
  error?: string;
}> {
  if (!Capacitor.isNativePlatform()) {
    return {
      registered: false,
      error: "Push notifications via FCM/APNs require native mobile environment",
    };
  }

  const granted = await requestPushPermissions();
  if (!granted) {
    return { registered: false, error: "Push notification permission denied by user" };
  }

  return new Promise((resolve) => {
    let settled = false;

    const registrationHandle = PushNotifications.addListener(
      "registration",
      (token: Token) => {
        if (!settled) {
          settled = true;
          resolve({ registered: true, token: token.value });
        }
      }
    );

    const errorHandle = PushNotifications.addListener(
      "registrationError",
      (err: { error: string }) => {
        if (!settled) {
          settled = true;
          resolve({ registered: false, error: err.error });
        }
      }
    );

    PushNotifications.register().catch((err: unknown) => {
      if (!settled) {
        settled = true;
        resolve({
          registered: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Timeout safety
    setTimeout(() => {
      if (!settled) {
        settled = true;
        void registrationHandle.then((h) => h.remove());
        void errorHandle.then((h) => h.remove());
        resolve({ registered: false, error: "Registration timed out" });
      }
    }, 10000);
  });
}

export async function subscribeToPushEvents(
  handlers: PushNotificationHandlers
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    return () => {};
  }

  const cleanups: Array<() => void> = [];

  if (handlers.onToken) {
    const handle = await PushNotifications.addListener("registration", (token: Token) => {
      handlers.onToken?.(token.value);
    });
    cleanups.push(() => handle.remove());
  }

  if (handlers.onRegistrationError) {
    const handle = await PushNotifications.addListener(
      "registrationError",
      (err: { error: string }) => {
        handlers.onRegistrationError?.(err.error);
      }
    );
    cleanups.push(() => handle.remove());
  }

  if (handlers.onNotificationReceived) {
    const handle = await PushNotifications.addListener(
      "pushNotificationReceived",
      (notification: PushNotificationSchema) => {
        handlers.onNotificationReceived?.(notification);
      }
    );
    cleanups.push(() => handle.remove());
  }

  if (handlers.onActionPerformed) {
    const handle = await PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (action: ActionPerformed) => {
        handlers.onActionPerformed?.(action);
      }
    );
    cleanups.push(() => handle.remove());
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
