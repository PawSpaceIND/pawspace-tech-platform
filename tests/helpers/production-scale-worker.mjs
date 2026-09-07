import{parentPort,workerData}from"node:worker_threads";
import{DatabaseSync}from"node:sqlite";
const db=new DatabaseSync(workerData.dbPath);db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
const latencies=[];let busyRetries=0,unrecoveredBusyCollisions=0;
const sleepBuffer=new Int32Array(new SharedArrayBuffer(4));
function isBusy(error){const value=String(error?.code||error);return value.includes("SQLITE_BUSY")||value.includes("SQLITE_BUSY_SNAPSHOT");}
function run(sql,...args){const started=performance.now();const statement=db.prepare(sql);let lastError;try{for(let attempt=0;attempt<=10;attempt++){try{statement.run(...args);return;}catch(error){lastError=error;if(!isBusy(error))throw error;if(attempt===10){unrecoveredBusyCollisions++;throw error;}busyRetries++;Atomics.wait(sleepBuffer,0,0,Math.min(2**attempt,32));}}throw lastError;}finally{latencies.push(performance.now()-started);}}
for(let c=workerData.start;c<workerData.end;c++){
 const customer=`C-${String(c).padStart(4,"0")}`;
 for(let p=0;p<10;p++){
  const provider=`P-${p}`;const slot=`S-${c%52}`;run("INSERT OR IGNORE INTO bookings(customer_id,provider_id,slot_key) VALUES (?,?,?)",customer,provider,slot);
 }
 const event=`CAP-${c}`;run("INSERT OR IGNORE INTO payment_events(event_id,kind,customer_id) VALUES (?,?,?)",event,"capture",customer);run("INSERT OR IGNORE INTO payment_events(event_id,kind,customer_id) VALUES (?,?,?)",event,"capture",customer);
 const refund=`REF-${c}`;run("INSERT OR IGNORE INTO refund_events(refund_id,customer_id) VALUES (?,?)",refund,customer);run("INSERT OR IGNORE INTO refund_events(refund_id,customer_id) VALUES (?,?)",refund,customer);
}
db.close();parentPort.postMessage({latencies,busyRetries,unrecoveredBusyCollisions});
