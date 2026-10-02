import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {d1} from './helpers/execution-harness.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__ADDRESS_DUP_DB__','__ADDRESS_DUP_ENV__');
const {mutateCustomerAccount,ensureCustomerAccountTables,readCustomerAccount}=await import('../lib/customer-account.ts');
const {sameSavedAddress,distinctSavedAddresses}=await import('../lib/saved-address-identity.ts');
const base={line1:'12, 100 Feet Road',area:'Indiranagar',city:'Bengaluru',postalCode:'560038'};

test('reordered/repeated locality reuses the saved address with fresh request keys and preserves units',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);await ensureCustomerAccountTables(db);
 sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES('A','blr','Synthetic','9876500000',1,1)").run();
 const save=(key,address)=>mutateCustomerAccount(db,{customerId:'A',action:'upsert_address',idempotencyKey:key,address});
 const first=await save('one',{...base,label:'Home',line2:'Tower A, Unit 12'});
 const second=await save('two',{...base,label:'Service address',line1:'12, Bengaluru, 100 Feet Road, Indiranagar, Bengaluru, 560038',line2:'Tower A, Unit 12'});
 assert.equal(second.entityId,first.entityId);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM customer_addresses').get().n,1);
 assert.equal((await save('two',{...base,line2:'Unit 999'})).duplicatePrevented,true);
 const third=await save('three',{...base,line2:'Tower A, Unit 13'});
 assert.notEqual(third.entityId,first.entityId);
 sqlite.exec('CREATE TABLE address_booking_links(id TEXT,address_id TEXT REFERENCES customer_addresses(id));');
 sqlite.prepare('INSERT INTO address_booking_links VALUES(?,?)').run('booking',first.entityId);
 const before=sqlite.prepare('SELECT * FROM customer_addresses ORDER BY id').all();
 // Historical duplicates remain stored and any booking references remain intact.
 sqlite.prepare("INSERT INTO customer_addresses SELECT 'LEGACY',customer_id,label,line1,line2,area,city,postal_code,0,created_at,updated_at FROM customer_addresses WHERE id=?").run(first.entityId);
 const account=await readCustomerAccount(db,'A');assert.equal(account.addresses.length,2);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM customer_addresses').get().n,3);
 assert.equal(sqlite.prepare('SELECT address_id FROM address_booking_links').get().address_id,first.entityId);
 sqlite.exec('CREATE TABLE customer_service_address_geocodes(address_id TEXT,customer_id TEXT,latitude REAL,longitude REAL)');
 sqlite.prepare('INSERT INTO customer_service_address_geocodes VALUES(?,?,?,?)').run(first.entityId,'A',12,77);
 sqlite.prepare('INSERT INTO customer_service_address_geocodes VALUES(?,?,?,?)').run('LEGACY','A',12.1,77);
 assert.equal((await readCustomerAccount(db,'A')).addresses.length,3,'different canonical coordinate evidence remains separately visible');
 for(const row of before)assert.deepEqual(sqlite.prepare('SELECT * FROM customer_addresses WHERE id=?').get(row.id),row);
});

test('conservative projection preserves coordinate differences, unknown evidence and distinct units',()=>{
 const rows=[{...base,id:'default',latitude:12,longitude:77},{...base,id:'same',latitude:12,longitude:77},{...base,id:'other',latitude:12.1,longitude:77},{...base,id:'unknown'},{...base,id:'unit',line2:'Unit 2',latitude:12,longitude:77}];
 assert.deepEqual(distinctSavedAddresses(rows).map(row=>row.id),['default','other','unknown','unit']);
 assert.equal(sameSavedAddress(base,{...base,line1:'12, 100 Feet Road, Bengaluru, Indiranagar, 560038'}),true);
 assert.equal(sameSavedAddress(base,{...base,line1:'12, 100 Feet Road, Unit 1'}),false);
 assert.equal(sameSavedAddress(base,{...base,postalCode:'560068'}),false);
 assert.equal(sameSavedAddress(base,{...base,area:'Different area'}),false);
});

async function collisionWorld(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);await ensureCustomerAccountTables(db);
 for(const owner of ['A','C-A','CA'])sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES(?,'blr','Synthetic','9876500000',1,1)").run(owner);
 return {sqlite,db,save:(owner,key,address)=>mutateCustomerAccount(db,{customerId:owner,action:'upsert_address',idempotencyKey:key,address})};
}
const colliders=[{...base,line1:'27312 Test Road',line2:'Unit 3196515248'},{...base,line1:'28995 Test Road',line2:'Unit 3845913171'}];
test('actual historical 32-bit collision and lossy customer tokens retain distinct canonical records',async t=>{
 const w=await collisionWorld(t);
 const results=[];
 for(const [index,address] of colliders.entries())results.push(await w.save('A',`collision-${index}`,address));
 results.push(await w.save('C-A','owner-hyphen',colliders[0]),await w.save('CA','owner-plain',colliders[0]));
 assert.equal(new Set(results.map(row=>row.entityId)).size,4);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM customer_addresses').get().n,4);
 for(const result of results)assert.equal(w.sqlite.prepare('SELECT customer_id FROM customer_addresses WHERE id=?').get(result.entityId).customer_id,result.customerId);
});
test('actual concurrent D1 saves reuse equivalent records and preserve different unit records',async t=>{
 const w=await collisionWorld(t);
 const equivalent=await Promise.all([w.save('A','race-1',base),w.save('A','race-2',{...base,line1:'12, Bengaluru, 100 Feet Road, Indiranagar, 560038'})]);
 assert.equal(equivalent[0].entityId,equivalent[1].entityId);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM customer_addresses').get().n,1);
 const different=await Promise.all([w.save('A','unit-1',{...base,line2:'Unit 1'}),w.save('A','unit-2',{...base,line2:'Unit 2'})]);
 assert.notEqual(different[0].entityId,different[1].entityId);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM customer_addresses').get().n,3);
});
test('forced digest collisions reject different identities and foreign owners without overwrites or false receipts',async t=>{
 const w=await collisionWorld(t),original=crypto.subtle.digest;
 crypto.subtle.digest=async()=>new Uint8Array(32).buffer;t.after(()=>{crypto.subtle.digest=original;});
 const first=await w.save('C-A','forced-first',colliders[0]);
 const before=w.sqlite.prepare('SELECT * FROM customer_addresses').all();
 for(const [owner,key,address] of [['C-A','forced-distinct',colliders[1]],['CA','forced-foreign',colliders[0]]]){
  await assert.rejects(w.save(owner,key,address),error=>error instanceof Response&&error.status===409);
  assert.deepEqual(w.sqlite.prepare('SELECT * FROM customer_addresses').all(),before);
  assert.equal(w.sqlite.prepare('SELECT count(*) n FROM customer_account_mutations WHERE idempotency_key=?').get(key).n,0);
 }
 assert.equal(w.sqlite.prepare('SELECT customer_id FROM customer_addresses WHERE id=?').get(first.entityId).customer_id,'C-A');
});
