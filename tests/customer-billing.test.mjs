import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {d1} from './helpers/execution-harness.mjs';
import {readCustomerBilling} from '../lib/customer-billing.ts';
test('billing reads only records owned by the customer on both sides of the booking join',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);
 sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT,customer_id TEXT,package_name TEXT,service_code TEXT);
 CREATE TABLE booking_payments(id TEXT,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,status TEXT,gateway TEXT,created_at INTEGER);
 CREATE TABLE booking_invoices(id TEXT,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER);
 INSERT INTO canonical_bookings VALUES('BA','A','Grooming','grooming'),('BB','B','Training','dog_training');
 INSERT INTO booking_payments VALUES('PA','BA','A',1000,0,'INR','card','captured','sandbox',1),('PB','BB','B',2000,0,'INR','card','captured','sandbox',1),('BAD','BB','A',2000,0,'INR','card','captured','sandbox',1);
 INSERT INTO booking_invoices VALUES('IA','BA','A','INV-A','issued','INR',1000,100,900,1,1),('IB','BB','B','INV-B','issued','INR',2000,200,1800,1,1),('BAD-I','BB','A','INV-X','issued','INR',2000,200,1800,1,1);`);
 const a=await readCustomerBilling(db,'A');assert.deepEqual(a.payments.map(p=>p.id),['PA']);assert.deepEqual(a.invoices.map(i=>i.id),['IA']);assert.equal(a.payments[0].amount,1000);assert.equal(a.invoices[0].tax_amount,100);
 const b=await readCustomerBilling(db,'B');assert.deepEqual(b.payments.map(p=>p.id),['PB']);assert.deepEqual(b.invoices.map(i=>i.id),['IB']);
});
test('uninitialized billing is explicitly unavailable, not a fabricated payment balance',async t=>{const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const value=await readCustomerBilling(d1(sqlite),'A');assert.equal(value.paymentsAvailable,false);assert.equal(value.invoicesAvailable,false);assert.deepEqual(value.payments,[]);});
test('billing storage failure propagates instead of silently returning empty records',async()=>{await assert.rejects(readCustomerBilling({prepare(){return{async all(){throw Error('database unavailable')}}}},'A'),/database unavailable/)});
