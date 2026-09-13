"use client";

type Purpose = "before_service" | "after_service";
export type QueuedProviderProof = {
  id: string; bookingId: string; purpose: Purpose; file: Blob; fileName: string;
  mimeType: string; sizeBytes: number; sha256: string; attempts: number;
  nextAttemptAt: number; createdAt: number;
};
const DB_NAME = "pawspace-provider-resilience";
const STORE = "proof_uploads";
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) { const db = await openDb(); try { return await request(run(db.transaction(STORE, mode).objectStore(STORE))); } finally { db.close(); } }
export async function queueProviderProof(input: Omit<QueuedProviderProof, "id" | "attempts" | "nextAttemptAt" | "createdAt">) {
  const item: QueuedProviderProof = { ...input, id: `${input.bookingId}:${input.purpose}:${input.sha256}`, attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now() };
  await tx("readwrite", store => store.put(item)); return item;
}
export async function flushProviderProofQueue(register: (item: QueuedProviderProof) => Promise<void>) {
  if (typeof indexedDB === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) return { uploaded: 0, pending: 0 };
  const db = await openDb(); let items: QueuedProviderProof[] = [];
  try { items = await request(db.transaction(STORE, "readonly").objectStore(STORE).getAll()) as QueuedProviderProof[]; } finally { db.close(); }
  let uploaded = 0, pending = 0;
  for (const item of items) {
    if (item.nextAttemptAt > Date.now()) { pending++; continue; }
    try { await register(item); await tx("readwrite", store => store.delete(item.id)); uploaded++; }
    catch { const attempts = item.attempts + 1; const retry = { ...item, attempts, nextAttemptAt: Date.now() + Math.min(60_000, 2 ** Math.min(attempts, 6) * 1_000) }; await tx("readwrite", store => store.put(retry)); pending++; }
  }
  return { uploaded, pending };
}
