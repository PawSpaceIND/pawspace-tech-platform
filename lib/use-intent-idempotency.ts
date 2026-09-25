"use client";

import { useState } from "react";

/**
 * One idempotency key per user intent, not per request.
 *
 * Lifecycle endpoints store a key only when the action commits. Reusing the key until the
 * action is confirmed therefore makes a retry after a lost response replay the committed
 * result instead of repeating the action, while a genuinely failed attempt left no record
 * and is simply processed again under the same key.
 */
export type IntentKeyStore = {
  keyFor(intent: string): string;
  settle(intent: string): void;
};

export function createIntentKeyStore(prefix: string, mint: () => string = () => crypto.randomUUID()): IntentKeyStore {
  const keys = new Map<string, string>();
  return {
    keyFor(intent) {
      let key = keys.get(intent);
      if (!key) {
        key = `${prefix}:${intent}:${mint()}`;
        keys.set(intent, key);
      }
      return key;
    },
    settle(intent) {
      keys.delete(intent);
    },
  };
}

/** Describes an intent by action and its user-chosen details, so different details never share a key. */
export function intentOf(parts: Array<string | undefined>, details: Record<string, unknown> = {}) {
  return [...parts.map((part) => part || "-"), JSON.stringify(details)].join(":");
}

export function useIntentIdempotency(prefix: string): IntentKeyStore {
  const [store] = useState(() => createIntentKeyStore(prefix));
  return store;
}
