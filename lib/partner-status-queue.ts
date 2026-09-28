import { boundedFetch, boundedJsonFetch } from "./bounded-fetch";
export type QueuedStatus = { id:string;providerId:string;bookingId:string;action:"on_the_way"|"arrived"|"start_service"|"complete";checklist:string[];createdAt:number;error?:string;attempts?:number;nextAttemptAt?:number };
const key=(provider:string)=>`pawspace:partner-status:v1:${encodeURIComponent(provider)}`;
export function readStatusQueue(provider:string,storage:Pick<Storage,"getItem">=localStorage):QueuedStatus[] {
  const raw=storage.getItem(key(provider));
  if(!raw)return[];
  const items:unknown=JSON.parse(raw);
  if(!Array.isArray(items)||items.some(item=>!item||item.providerId!==provider||typeof item.id!=="string"||typeof item.bookingId!=="string"||!["on_the_way","arrived","start_service","complete"].includes(item.action)||!Array.isArray(item.checklist)||!Number.isFinite(item.createdAt)))throw new Error("Saved updates could not be read. Contact Operations before continuing.");
  return items as QueuedStatus[];
}
export function saveStatusQueue(provider:string,items:QueuedStatus[],storage:Pick<Storage,"setItem">=localStorage) {
  storage.setItem(key(provider),JSON.stringify(items));
}
export function enqueueStatus(input:Omit<QueuedStatus,"id"|"createdAt">):QueuedStatus {
  const items=readStatusQueue(input.providerId);
  const existing=items.find(item=>item.bookingId===input.bookingId);
  // [LP-D07] An item still awaiting delivery (no error yet) genuinely conflicts with a second update for
  // the same job. An item that already FAILED (e.g. a 409 geofence refusal - "tap Mark arrived again once
  // you are at the address") is a resolved outcome, not an in-flight one: a fresh tap of the primary
  // control replaces it with the new attempt instead of being refused forever by its own stale entry.
  if(existing&&!existing.error)throw new Error("This job already has a pending update. Sync or resolve it before sending another.");
  const item={...input,id:crypto.randomUUID(),createdAt:Date.now()};
  const next=existing?items.map(value=>value.id===existing.id?item:value):[...items,item];
  saveStatusQueue(input.providerId,next); // A failed disk write must prevent optimistic success.
  return item;
}
const targets={on_the_way:"on_the_way",arrived:"arrived",start_service:"in_service",complete:"completed"};
const order=["assigned","on_the_way","arrived","in_service","completed"];
export function statusAlreadyApplied(item:QueuedStatus,status:string) {
  return order.includes(status)&&order.indexOf(status)>=order.indexOf(targets[item.action]);
}
export const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const text = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
export function deferStatusRetry(item: QueuedStatus, failure: { retryAfterMs?: number }, now = Date.now(), random = Math.random): QueuedStatus {
  const attempts = Math.min(30, Math.max(0, item.attempts ?? 0) + 1);
  const backoff = Math.min(60_000, 2 ** Math.min(attempts, 6) * 1000);
  const jittered = Math.round(backoff * (0.8 + Math.min(1, Math.max(0, random())) * 0.2));
  const advised = Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs ?? 0) : 0;
  return { ...item, attempts, nextAttemptAt: now + Math.max(jittered, advised) };
}
/** Replay only after the authenticated server confirms current assignment. A lost response is reconciled before retry. */
export async function deliverStatus(item: QueuedStatus, send: typeof boundedFetch = boundedFetch): Promise<void> {
  const read = async (url: string, options: RequestInit) => {
    let response: Response, body: unknown;
    try {
      if (send === boundedFetch) ({ response, body } = await boundedJsonFetch(url, options));
      else {
        response = await send(url, options);
        body = await response.json().catch(error => { if (response.ok) throw error; return null; });
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error("Connection lost"), { retry: true });
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (!response.ok) throw Object.assign(new Error(typeof record.error === "string" ? record.error : response.status === 401 ? "Sign in again before syncing saved updates" : "Unable to verify or update this job"), {
      retry: retryableStatus(response.status), retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Incomplete server response. Saved update will be retried."), { retry: true });
    return record;
  };
  const body = await read(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(item.bookingId)}`, { cache: "no-store" });
  const data = body.data as { booking?: { provider_id?: unknown; status?: unknown } } | undefined;
  const booking = data?.booking;
  if (!booking || String(booking.provider_id) !== item.providerId) throw new Error("Assignment changed. Ask Operations to resolve this pending update.");
  if (statusAlreadyApplied(item, String(booking.status))) return;
  if (Date.now() - item.createdAt > 24 * 60 * 60_000) throw new Error("This update is over 24 hours old. Ask Operations to reconcile it.");
  await read("/api/grooming-lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: item.bookingId, action: item.action, checklist: item.checklist, clientEventId: item.id }) });
}

/** Web Locks serialize read/modify/write and replay across tabs sharing the same origin. */
export async function withStatusQueueLock<T>(provider:string,kind:"storage"|"delivery",work:()=>T|Promise<T>):Promise<T> {
  if(typeof navigator==="undefined"||!navigator.locks)throw new Error("This browser cannot safely save offline updates. Use an updated browser or partner app and contact Operations.");
  return navigator.locks.request(`${key(provider)}:${kind}`,work);
}
