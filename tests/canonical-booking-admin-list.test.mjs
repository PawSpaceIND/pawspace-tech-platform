import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCanonicalBookingsForAdmin } from '../lib/canonical-booking-admin-list.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pawspace-admin-list-'));
  const path = join(dir, 'db.sqlite');
  const sql = new DatabaseSync(path);
  sql.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,created_at INTEGER,status TEXT);
    CREATE TABLE provider_work_orders(id TEXT,booking_id TEXT,provider_name TEXT,provider_model TEXT,status TEXT,occurrence_count INTEGER);
    CREATE TABLE booking_payments(id TEXT,booking_id TEXT,status TEXT,amount_due_now REAL,gateway TEXT);
    CREATE TABLE canonical_pets(id TEXT,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT);
    CREATE TABLE booking_lifecycle_events(id TEXT,booking_id TEXT,event_type TEXT,occurred_at INTEGER,detail_json TEXT);
    INSERT INTO canonical_customers VALUES('customer','Demo customer');
    INSERT INTO canonical_pets VALUES('pet-z','customer','Zebra','dog','mixed','verified'),('pet-a','customer','Alpha','dog','mixed','verified'),('foreign','other','Wrong owner','dog','mixed','verified');`);
  let batches = 0, statements = 0;
  const db = {
    prepare: query => ({ query }),
    batch: async list => {
      batches++; statements += list.length;
      sql.exec('BEGIN');
      try {
        const result = list.map((item, index) => {
          const rows = sql.prepare(item.query).all();
          if (index === 0) db.afterFirstRead?.();
          return {results:rows};
        });
        sql.exec('COMMIT'); return result;
      } catch(error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  function booking(n) {
    const id = `booking-${String(n).padStart(3,'0')}`;
    sql.prepare('INSERT INTO canonical_bookings VALUES(?,?,?,?,?)').run(id,'customer','["pet-z","pet-a","foreign"]',n,'confirmed');
    sql.prepare('INSERT INTO provider_work_orders VALUES(?,?,?,?,?,?)').run(`work-${n}`,id,'Demo provider','commission','assigned',1);
    sql.prepare('INSERT INTO booking_payments VALUES(?,?,?,?,?)').run(`pay-${n}`,id,'captured',1899,'uat_sandbox');
    return id;
  }
  return {sql,db,path,booking,counts:()=>({batches,statements}),close:()=>{sql.close();rmSync(dir,{recursive:true,force:true});}};
}

test('admin list uses one bounded batch and retains ownership, ordering and payment details', async () => {
  const f = fixture();
  try {
    for(let n=0;n<105;n++) f.booking(n);
    f.sql.exec(`INSERT INTO booking_lifecycle_events VALUES('late','booking-104','completed',20,'{}'),('early','booking-104','created',10,'{}'),('excluded','booking-000','created',1,'{}')`);
    const rows = await listCanonicalBookingsForAdmin(f.db);
    assert.deepEqual(f.counts(),{batches:1,statements:3});
    assert.equal(rows.length,100); assert.equal(rows[0].id,'booking-104'); assert.equal(rows.at(-1).id,'booking-005');
    assert.equal(rows[0].customer_name,'Demo customer');assert.equal(rows[0].payment_status,'captured');assert.equal(rows[0].amount_due_now,1899);
    assert.deepEqual(rows[0].pets.map(p=>p.id),['pet-a','pet-z']);
    assert.ok(rows.every(row=>row.pets.every(p=>!('list_booking_id' in p))));
    assert.deepEqual(rows[0].events.map(e=>e.id),['early','late']);
    assert.deepEqual(rows[1].events,[]);
  } finally { f.close(); }
});

test('list and lifecycle children remain on the same snapshot during a concurrent completion', async () => {
  const f = fixture();const writer = new DatabaseSync(f.path);
  try {
    f.booking(1);
    f.db.afterFirstRead = () => writer.exec(`BEGIN; UPDATE canonical_bookings SET status='completed'; INSERT INTO booking_lifecycle_events VALUES('completion','booking-001','completed',30,'{}'); COMMIT;`);
    const rows = await listCanonicalBookingsForAdmin(f.db);
    assert.equal(rows[0].status,'confirmed');assert.deepEqual(rows[0].events,[]);
    delete f.db.afterFirstRead;
    const refreshed = await listCanonicalBookingsForAdmin(f.db);
    assert.equal(refreshed[0].status,'completed');assert.equal(refreshed[0].events[0].event_type,'completed');
  } finally { writer.close();f.close(); }
});

test('empty booking database returns an empty list', async () => {
  const f=fixture();try{assert.deepEqual(await listCanonicalBookingsForAdmin(f.db),[]);}finally{f.close();}
});
