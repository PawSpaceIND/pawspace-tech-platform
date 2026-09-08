"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { App, type URLOpenListenerEvent } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

export function parseDeepLinkUrl(url: string): string | null {
  if (!url) return null;

  // 1. Custom scheme: pawspace://<path>?<query>
  if (url.startsWith("pawspace://")) {
    const raw = url.replace("pawspace://", "");
    return raw.startsWith("/") ? raw : `/${raw}`;
  }

  // 2. Universal / App Links: e.g. https://staging-api.pawspace.in/<path> or https://pawspace.in/<path>
  if (url.includes(".in")) {
    const slug = url.split(".in").pop();
    if (slug) {
      return slug.startsWith("/") ? slug : `/${slug}`;
    }
  }

  // 3. Fallback for absolute http(s) URLs
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export default function MobileDeepLinkHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return;
    }

    let isMounted = true;
    let listenerHandle: { remove: () => Promise<void> } | null = null;

    const setupDeepLinking = async () => {
      try {
        const handle = await App.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
          if (!isMounted || !event.url) return;
          console.info("[PawSpace Deep Link] Incoming native URL:", event.url);

          // Handle Razorpay sandbox payment callback redirects
          if (event.url.includes("payment/callback") || event.url.includes("razorpay_payment_id")) {
            console.info("[PawSpace Deep Link] Intercepted Razorpay sandbox payment redirect");
            window.dispatchEvent(
              new CustomEvent("pawspace:razorpay-callback", { detail: { url: event.url } })
            );
          }

          // Parse destination slug / path
          const destination = parseDeepLinkUrl(event.url);
          if (destination && isMounted) {
            console.info("[PawSpace Deep Link] Navigating to target route:", destination);
            router.push(destination);
          }
        });

        if (!isMounted) {
          void handle.remove();
        } else {
          listenerHandle = handle;
        }
      } catch (err) {
        console.warn("[PawSpace Deep Link] Failed to attach appUrlOpen listener:", err);
      }
    };

    void setupDeepLinking();

    return () => {
      isMounted = false;
      if (listenerHandle) {
        void listenerHandle.remove();
      }
    };
  }, [router]);

  return null;
}
