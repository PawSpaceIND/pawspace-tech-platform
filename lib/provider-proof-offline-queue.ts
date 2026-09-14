"use client";

type Purpose = "before_service" | "after_service";
export type QueuedProviderProof = {
  id: string; bookingId: string; purpose: Purpose; file: Blob; fileName: string;
  mimeType: string; sizeBytes: number; sha256: string; attempts: number;
  nextAttemptAt: number; createdAt: number;
};
export type ProviderProofFlushResult = { uploaded: number; pending: number; discarded: number; skipped: number };
/** "in_flight": another dispatcher holds the item. "withdrawn": the item left the queue before this dispatcher could send it. */
export type ProviderProofDispatchOutcome = "uploaded" | "in_flight" | "withdrawn";
const DB_NAME = "pawspace-provider-resilience";
const STORE = "proof_uploads";
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) { const db = await openDb(); try { return await request(run(db.transaction(STORE, mode).objectStore(STORE))); } finally { db.close(); } }

/**
 * One queue entry per (booking, purpose, bytes). The id is derived from the SHA-256 the app computes over
 * the file BEFORE anything is queued or sent, so adding the same photo twice replaces the entry rather than
 * duplicating it, and the server sees one registration per distinct file.
 */
export const providerProofQueueId = (input: { bookingId: string; purpose: Purpose; sha256: string }) =>
  `${input.bookingId}:${input.purpose}:${input.sha256.trim().toLowerCase()}`;
export async function queueProviderProof(input: Omit<QueuedProviderProof, "id" | "attempts" | "nextAttemptAt" | "createdAt">) {
  const sha256 = input.sha256.trim().toLowerCase();
  const item: QueuedProviderProof = { ...input, sha256, id: providerProofQueueId({ ...input, sha256 }), attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now() };
  await tx("readwrite", store => store.put(item)); return item;
}
/** The row as the queue holds it NOW, or undefined once an upload, a discard or a session boundary removed it. */
const queuedRow = (id: string) => tx("readonly", store => store.get(id)) as Promise<QueuedProviderProof | undefined>;
/** Drop a queued proof that the server has refused for good (a 4xx that a retry can never fix). */
export async function discardProviderProof(id: string) { if (typeof indexedDB === "undefined") return; await tx("readwrite", store => store.delete(id)); }
/**
 * A provider session boundary owns its offline proof queue. Never carry one partner's bytes into the next
 * session: the store is cleared, and a flush still walking rows it read before this point stops at its next
 * row and re-queues nothing, so the ended session's proofs are never registered under the next one.
 */
let queueGeneration = 0;
export async function clearProviderProofQueue() { queueGeneration++; if (typeof indexedDB === "undefined") return; await tx("readwrite", store => store.clear()); }
/** An error carrying `permanent: true` tells the flush loop to discard the item instead of retrying it. */
export const isPermanentProofError = (error: unknown): error is Error & { permanent: true } => Boolean(error && typeof error === "object" && (error as { permanent?: unknown }).permanent === true);

/**
 * One dispatcher per queue id, across every tab that shares the queue. Two dispatchers can see the same
 * queued item: the Partner app flushes the queue every 15 s and on `online`, a photo is queued BEFORE it is
 * registered so that it survives a dropped connection, and IndexedDB is shared by every open tab of the app.
 * Without this lock a flush that fired while a fresh photo was still uploading registered the same bytes a
 * second time, leaving a duplicate asset in the Ops review queue that never received its bytes ("upload
 * incomplete" on approval). `inFlight` settles the in-tab race synchronously; the Web Locks API, where the
 * browser has it, extends the same lock to the other tabs. `ifAvailable`: a lock held elsewhere is a skip,
 * never a wait behind another tab's upload.
 */
const inFlight = new Set<string>();
export const isProviderProofInFlight = (id: string) => inFlight.has(id);
async function withProofLock<T>(id: string, run: () => Promise<T>): Promise<T | "in_flight"> {
  if (inFlight.has(id)) return "in_flight";
  inFlight.add(id);
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return await run();
    return await (locks.request(`pawspace-proof-upload:${id}`, { ifAvailable: true }, lock => (lock ? run() : Promise.resolve("in_flight" as const))) as Promise<T | "in_flight">);
  } finally { inFlight.delete(id); }
}

/**
 * Register and upload one queued proof exactly once, then remove it from the queue. "in_flight" means another
 * dispatcher (a running flush, or another tab) holds this item and nothing was sent; "withdrawn" means the
 * item was no longer queued (uploaded elsewhere, discarded, or cleared at a session boundary) and nothing was
 * sent either. A register failure propagates to the caller, which decides between discarding (permanent) and
 * leaving the item queued for retry.
 */
export async function dispatchQueuedProof(item: QueuedProviderProof, register: (item: QueuedProviderProof) => Promise<void>): Promise<ProviderProofDispatchOutcome> {
  return withProofLock(item.id, async () => {
    if (!(await queuedRow(item.id))) return "withdrawn" as const;
    await register(item); await discardProviderProof(item.id); return "uploaded" as const;
  });
}

let flushInProgress: Promise<ProviderProofFlushResult> | null = null;
/** Single-flight: a flush that starts while one is still walking the queue joins it instead of walking again. */
export function flushProviderProofQueue(register: (item: QueuedProviderProof) => Promise<void>): Promise<ProviderProofFlushResult> {
  if (flushInProgress) return flushInProgress;
  const run = flushQueueOnce(register).finally(() => { if (flushInProgress === run) flushInProgress = null; });
  flushInProgress = run;
  return run;
}
async function flushQueueOnce(register: (item: QueuedProviderProof) => Promise<void>): Promise<ProviderProofFlushResult> {
  if (typeof indexedDB === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) return { uploaded: 0, pending: 0, discarded: 0, skipped: 0 };
  const generation = queueGeneration;
  const db = await openDb(); let items: QueuedProviderProof[] = [];
  try { items = await request(db.transaction(STORE, "readonly").objectStore(STORE).getAll()) as QueuedProviderProof[]; } finally { db.close(); }
  let uploaded = 0, pending = 0, discarded = 0, skipped = 0;
  for (const item of items) {
    // The session that queued these rows has ended (logout, provider switch): what it read is not this session's to send.
    if (generation !== queueGeneration) break;
    if (item.nextAttemptAt > Date.now()) { pending++; continue; }
    const outcome = await withProofLock(item.id, async () => {
      // Re-read under the lock. Another tab may have uploaded and removed the row since this walk began, or a
      // session boundary may have cleared it; a row that is gone is never sent from the stale copy.
      const current = await queuedRow(item.id);
      if (!current || generation !== queueGeneration) return "withdrawn" as const;
      try { await register(current); await tx("readwrite", store => store.delete(item.id)); return "uploaded" as const; }
      catch (error) {
        // A permanent refusal (grant mismatch, ownership, unsupported type) would otherwise re-register a
        // fresh asset every cycle for ever; only transport-class failures earn the exponential retry.
        if (isPermanentProofError(error)) { await tx("readwrite", store => store.delete(item.id)); return "discarded" as const; }
        if (generation !== queueGeneration) return "withdrawn" as const;
        const attempts = current.attempts + 1; const retry = { ...current, attempts, nextAttemptAt: Date.now() + Math.min(60_000, 2 ** Math.min(attempts, 6) * 1_000) }; await tx("readwrite", store => store.put(retry)); return "pending" as const;
      }
    });
    if (outcome === "uploaded") uploaded++; else if (outcome === "discarded") discarded++; else if (outcome === "pending") pending++; else skipped++;
  }
  return { uploaded, pending, discarded, skipped };
}
