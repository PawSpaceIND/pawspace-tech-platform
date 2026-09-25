const ensured=new WeakMap<object,Map<string,Promise<void>>>();

export function ensureD1Once(db:object,key:string,run:()=>Promise<void>){
 let byKey=ensured.get(db);
 if(!byKey){byKey=new Map();ensured.set(db,byKey);}
 const existing=byKey.get(key);if(existing)return existing;
 const pending=run().catch(error=>{byKey!.delete(key);throw error;});
 byKey.set(key,pending);
 return pending;
}
