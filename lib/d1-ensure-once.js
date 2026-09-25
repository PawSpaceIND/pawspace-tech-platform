/** @type {WeakMap<object, Map<string, Promise<void>>>} */
const ensured=new WeakMap();

/**
 * Run one idempotent D1/schema setup per binding + key. Concurrent callers share
 * the same promise; a failed setup is evicted so a later request can retry.
 * @param {object} db
 * @param {string} key
 * @param {()=>Promise<void>} run
 * @returns {Promise<void>}
 */
export function ensureD1Once(db,key,run){
 let byKey=ensured.get(db);
 if(!byKey){byKey=new Map();ensured.set(db,byKey);}
 const existing=byKey.get(key);
 // A caller that joined someone else's attempt retries once if that attempt failed, so one transient
 // failure fails the request that hit it rather than every request that happened to be in flight.
 if(existing)return existing.catch(()=>ensureD1Once(db,key,run));
 const pending=run().catch(error=>{if(byKey.get(key)===pending)byKey.delete(key);throw error;});
 byKey.set(key,pending);
 return pending;
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
export function ensureD1OnceApplied(db,key,run){
 let byKey=ensured.get(db);
 if(!byKey){byKey=new Map();ensured.set(db,byKey);}
 const existing=byKey.get(key);if(existing)return existing;
 const pending=run().then(applied=>{if(!applied&&byKey.get(key)===pending)byKey.delete(key);},error=>{if(byKey.get(key)===pending)byKey.delete(key);throw error;});
 byKey.set(key,pending);
 return pending;
}
