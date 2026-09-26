import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) { try { return next(specifier, context); } catch(error) { if(specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier+'.ts', context); throw error; } }});
const { analyticsBookings, parseBookingSlice } = await import('../lib/analytics-bookings.ts');
const params = (extra = {}) => parseBookingSlice(new URLSearchParams({from:'2026-09-01',to:'2026-09-02',...extra}));
function fixture() {
 const sql = new DatabaseSync(':memory:');
 sql.exec('CREATE TABLE canonical_bookings(id TEXT, service_code TEXT, city_id TEXT,status TEXT,scheduled_start TEXT,total_amount REAL,currency TEXT)');
 const insert = sql.prepare('INSERT INTO canonical_bookings VALUES(?,?,?,?,?,?,?)');
 for(let i=0;i<55;i++) insert.run(`good-${String(i).padStart(2,'0')}`,'grooming','blr','completed','2026-09-02T10:00:00',100,'INR');
 insert.run('cancelled','grooming','blr','cancelled','2026-09-01T00:00:00',900,'INR');
 insert.run('draft','grooming','blr','draft','2026-09-01T23:59:00',900,'INR');
 insert.run('outside-date','grooming','blr','completed','2026-09-03T00:00:00',900,'INR');
 insert.run('outside-city','grooming','hyd','completed','2026-09-02T12:00:00',900,'INR');
 insert.run('other-service','boarding','blr','confirmed','2026-09-02T12:00:00',900,'INR');
 function statement(query, args=[]) { return {bind:(...values)=>statement(query,values), first:async()=>sql.prepare(query).get(...args), all:async()=>({results:sql.prepare(query).all(...args)})}; }
 return {db:{prepare:query=>statement(query)},sql};
}
test('drill-down retains inclusive dates, service, revenue status and manager city',async()=>{
 const {db,sql}=fixture();
 const data=await analyticsBookings(db,params({serviceCode:'grooming',status:'recognized'}),'blr');
 assert.equal(data.total,55); assert.equal(data.rows.length,50);
 assert.equal(data.rows.reduce((sum,row)=>sum+row.total_amount,0),5000);
 assert.ok(data.rows.every(row=>row.id.startsWith('good-')));
 const second=await analyticsBookings(db,params({serviceCode:'grooming',status:'recognized',offset:'50'}),'blr');
 assert.equal(second.rows.length,5); assert.equal(new Set([...data.rows,...second.rows].map(row=>row.id)).size,55);
 assert.equal((await analyticsBookings(db,params({status:'cancelled'}),'blr')).rows[0].id,'cancelled');
 assert.deepEqual(new Set((await analyticsBookings(db,params({status:'other'}),'blr')).rows.map(row=>row.id)),new Set(['draft','other-service']));
 assert.equal((await analyticsBookings(db,params({serviceCode:'grooming'}))).total,58);
 sql.close();
});
test('reject malformed dates, excessive windows, injection and invalid pagination',()=>{
 for(const extra of [{from:'2026-02-30'},{to:'2026-08-30'},{from:'2020-01-01'},{serviceCode:"grooming' OR 1=1 --"},{status:'pending'},{offset:'-1'},{offset:'1.5'},{offset:'Infinity'}]) assert.throws(()=>params(extra));
});
test('query failures propagate instead of appearing as zero bookings',async()=>{
 await assert.rejects(()=>analyticsBookings({prepare(){throw new Error('database unavailable')}},params()),/database unavailable/);
});
