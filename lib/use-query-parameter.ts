"use client";

import { useSyncExternalStore } from "react";

/**
 * Reads a query parameter only after hydration. Initial server and client
 * renders therefore match, avoiding the provider-workspace hydration crash.
 */
export function useQueryParameter(name: string) {
  return useSyncExternalStore(
    () => () => undefined,
    () => new URLSearchParams(window.location.search).get(name) || "",
    () => "",
  );
}
