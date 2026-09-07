type LifecycleLockInput={bookingId:string;actorId:string;action:string};

const LIFECYCLE_LOCK_TTL_MS=120_000;

function lockConflict(){
 return new Response(JSON.stringify({error:"Another lifecycle mutation is already in progress for this booking."}),{status:409,headers:{"content-type":"application/json"}});
}

export async function ensureLifecycleMutationLockTable(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS lifecycle_mutation_locks (booking_id TEXT PRIMARY KEY,token TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,acquired_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)").run();
}

export async function withLifecycleMutationLock<T>(db:D1Database,input:LifecycleLockInput,operation:()=>Promise<T>):Promise<T>{
 if(!input.bookingId||!input.actorId||!input.action)throw new Response("Booking, actor and action are required for lifecycle mutation locking",{status:400});
 await ensureLifecycleMutationLockTable(db);
 const token=crypto.randomUUID(),now=Date.now(),expiresAt=now+LIFECYCLE_LOCK_TTL_MS;
 const claim=await db.prepare("INSERT INTO lifecycle_mutation_locks (booking_id,token,actor_id,action,acquired_at,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET token=excluded.token,actor_id=excluded.actor_id,action=excluded.action,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at WHERE lifecycle_mutation_locks.expires_at<=?").bind(input.bookingId,token,input.actorId,input.action,now,expiresAt,now).run();
 if(Number((claim as {meta?:{changes?:number}})?.meta?.changes||0)!==1)throw lockConflict();
 try{return await operation();}
 finally{
  try{await db.prepare("DELETE FROM lifecycle_mutation_locks WHERE booking_id=? AND token=?").bind(input.bookingId,token).run();}catch{/* Expiry is the crash-safe fallback; release failure must not rewrite a committed lifecycle result. */}
 }
}
