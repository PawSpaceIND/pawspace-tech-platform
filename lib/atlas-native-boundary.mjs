import { AsyncLocalStorage } from 'node:async_hooks';
import { installGenerationGuard } from './atlas-generation-shape-guard.mjs';
const scope = new AsyncLocalStorage();
const deny = () => { throw new Error('ATLAS_NATIVE_TRANSPORT_DENIED'); };
let installed = false;
export function atlasRequestEnv(env) {
  const db = env.DB;
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || 'fetch' in db) deny();
  const clean = { DB: db };
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) clean[name] = value;
  }
  // Version metadata is inert data; no other object binding enters the Atlas envelope.
  const version = env.CF_VERSION_METADATA;
  if (version && typeof version === 'object') {
    const metadata = {};
    for (const name of ['id', 'tag', 'timestamp']) if (typeof version[name] === 'string') metadata[name] = version[name];
    clean.CF_VERSION_METADATA = metadata;
  }
  return clean;
}
export function installAtlasNativeBoundary(target = globalThis) {
  if (installed) return; installed = true;
  const native = target.fetch.bind(target), NativeWebSocket = target.WebSocket;
  const shapeTarget = { fetch: native };
  const exactGeneration = installGenerationGuard(shapeTarget);
  Object.defineProperty(target, 'fetch', { configurable: false, writable: false, value: async (input, init) => {
    const context = scope.getStore();
    if (!context) deny();
    if (context.kind === 'ordinary') return native(input, init);
    // Capture accessor-backed options once before comparing the ledger-bound immutable body.
    if (!init || typeof input !== 'string') deny();
    const snapshot = { method: init.method, body: init.body, headers: init.headers, signal: init.signal };
    const permit = context.permit;
    if (!permit || permit.used || input !== 'https://api.openai.com/v1/responses' || snapshot.method !== 'POST' || snapshot.body !== permit.body || Date.now() >= permit.expiresAt) deny();
    permit.used = true; // Uncertain dispatch consumes the capability; never retry it.
    return exactGeneration(input, snapshot);
  }});
  Object.defineProperty(target, 'WebSocket', { configurable: false, writable: false, value: class {
    constructor(...args) { if (scope.getStore()?.kind !== 'ordinary' || !NativeWebSocket) deny(); return Reflect.construct(NativeWebSocket, args); }
  }});
}
export function withAtlasNativeScope(kind, operation) {
  if (kind !== 'ordinary' && kind !== 'atlas') deny();
  return scope.run({ kind, permit: null }, operation);
}
// Call ONLY after reserveTextTest's guarded INSERT reports exactly one changed row.
// This is an internal capability mint, never a request field or exported HTTP handler.
export function bindReservedAtlasGeneration({ claimId, body, expiresAt }) {
  const context = scope.getStore();
  if (context?.kind !== 'atlas' || context.permit || typeof claimId !== 'string' || !claimId.startsWith('ATLASTEXT-') || typeof body !== 'string' || !Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) deny();
  context.permit = { claimId, body, expiresAt, used: false };
}

export function isAtlasNativeScope() { return scope.getStore()?.kind === "atlas"; }
