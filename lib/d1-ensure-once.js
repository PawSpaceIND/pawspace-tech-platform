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
 const existing=byKey.get(key);if(existing)return existing;
 const pending=run().catch(error=>{byKey.delete(key);throw error;});
 byKey.set(key,pending);
 return pending;
}
