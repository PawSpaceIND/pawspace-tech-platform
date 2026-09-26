/** @type {WeakMap<object, Set<string>>} */
const ready=new WeakMap();

/*
 * Ready-set only: no in-flight promise is shared across requests (a cancelled request's promise never settles).
 *
 * These helpers used to cache the in-flight setup promise per binding and hand it to every concurrent
 * caller. In the Workers runtime a request that is cancelled (the browser navigates away, a poll is
 * aborted, a deadline answers first) has its unfinished I/O cancelled, and a promise waiting on that
 * I/O never settles. Every later request on the isolate that joined the cached promise then waited
 * for ever and the runtime killed it: the staging sitter workspace saw GET /api/provider-chat fail
 * with Cloudflare's "Worker threw exception" (1101) while the chat poll kept retrying. The same
 * fix already covers the platform-session, identity-binding, service-zone and control-switch guards.
 *
 * Now a key is remembered only once its setup has COMPLETED. Until then each caller runs the setup
 * itself; every setup passed here is idempotent (CREATE ... IF NOT EXISTS, guarded ALTERs), so a
 * cold isolate with concurrent first requests only repeats harmless DDL.
 */
function readySet(db){let keys=ready.get(db);if(!keys){keys=new Set();ready.set(db,keys);}return keys;}

/**
 * Run one idempotent D1/schema setup per binding + key; after it has succeeded once, later calls
 * return immediately. A failed setup is not remembered, so the next call retries it.
 * @param {object} db
 * @param {string} key
 * @param {()=>Promise<void>} run
 * @returns {Promise<void>}
 */
export async function ensureD1Once(db,key,run){
 const keys=readySet(db);
 if(keys.has(key))return;
 await run();
 keys.add(key);
}

/**
 * Like ensureD1Once, for setup that depends on a table another module creates later: `run` resolves
 * true once the setup was actually applied, and only then is it remembered. Until then every call
 * re-checks, so a binding whose first request arrived before the dependency still gets the setup.
 * @param {object} db
 * @param {string} key
 * @param {()=>Promise<boolean>} run
 * @returns {Promise<void>}
 */
export async function ensureD1OnceApplied(db,key,run){
 const keys=readySet(db);
 if(keys.has(key))return;
 if(await run())keys.add(key);
}
