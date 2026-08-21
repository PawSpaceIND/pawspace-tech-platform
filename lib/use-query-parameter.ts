"use client";

import { useSyncExternalStore } from "react";

const URL_CHANGE_EVENT = "pawspace:urlchange";
let historyEventsInstalled = false;

function installHistoryEvents() {
  if (historyEventsInstalled || typeof window === "undefined") return;
  historyEventsInstalled = true;

  const pushState = window.history.pushState.bind(window.history);
  const replaceState = window.history.replaceState.bind(window.history);

  window.history.pushState = ((...args: Parameters<History["pushState"]>) => {
    pushState(...args);
    window.dispatchEvent(new Event(URL_CHANGE_EVENT));
  }) as History["pushState"];
  window.history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    replaceState(...args);
    window.dispatchEvent(new Event(URL_CHANGE_EVENT));
  }) as History["replaceState"];
}

function subscribe(listener: () => void) {
  installHistoryEvents();
  window.addEventListener("popstate", listener);
  window.addEventListener(URL_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(URL_CHANGE_EVENT, listener);
  };
}

/**
 * Hydration-safe and navigation-reactive query parameter reader. The server
 * snapshot remains empty, while client-side history and popstate changes
 * trigger a fresh snapshot without requiring a full page reload.
 */
export function useQueryParameter(name: string) {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name) || "",
    () => "",
  );
}
