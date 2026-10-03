import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {installWorkersHooks} from './module-hooks.mjs';

// Builtins load before hooks; the actual admission module uses an ESM file URL.
installWorkersHooks('__ATLAS_RACE_DB__','__ATLAS_RACE_ENV__');
const {reserveTextTest}=await import(workerData.module);
const sql=new DatabaseSync(workerData.file);sql.exec('PRAGMA busy_timeout=5000');
const db={prepare:s=>({bind:(...v)=>({run:async()=>({meta:{changes:Number(sql.prepare(s).run(...v).changes)}})})})};
parentPort.postMessage('ready');
parentPort.once('message',async()=>{
 try{await reserveTextTest(db,workerData.env,workerData.input,workerData.now);parentPort.postMessage('admitted');}
 catch{parentPort.postMessage('refused');}
 finally{sql.close();}
});
