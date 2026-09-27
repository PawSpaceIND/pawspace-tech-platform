import test from 'node:test';import assert from 'node:assert/strict';
import {installWorkersHooks}from'./helpers/module-hooks.mjs';installWorkersHooks('__SEARCH_DB__','__SEARCH_ENV__');
const{matchesCustomerSearch}=await import('../lib/customer-search.ts');
const record={customerId:'CUS-TEST',name:'QA Booking',primaryPhone:'+91 97085 63488',crmStage:'New',owner:'QA'};
test('phone formatting matches before masking without changing the customer record',()=>{
 for(const q of ['9708563488','+91 97085 63488','(970) 856-3488'])assert.equal(matchesCustomerSearch(record,q),true);
 assert.equal(matchesCustomerSearch(record,'9708563499'),false);
 assert.equal(record.primaryPhone,'+91 97085 63488');
});
test('name, ID and stage searches remain supported',()=>{
 for(const q of ['qa booking','cus-test','new',''])assert.equal(matchesCustomerSearch(record,q),true);
 assert.equal(matchesCustomerSearch(record,'missing'),false);
});

test('full-phone search finds older customers outside the recent directory window and excludes merged records',async()=>{
 const{freshSqlite,makeD1}=await import('./helpers/voice-harness.mjs');const sqlite=freshSqlite();
 sqlite.exec(`CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,primary_phone TEXT,merged_into TEXT);CREATE TABLE crm_contacts(id TEXT PRIMARY KEY,primary_phone TEXT,stage TEXT);
 INSERT INTO canonical_customers VALUES('older','+91 (97085) 63488',NULL),('merged','9708563488','older');
 INSERT INTO crm_contacts VALUES('older','9708563488','Active'),('crm-only','09708563488','New'),('merged-crm','9708563488','Merged');`);
 for(let i=0;i<600;i++)sqlite.prepare('INSERT INTO canonical_customers VALUES(?,?,NULL)').run(`new-${i}`,`800000${String(i).padStart(4,'0')}`);
 const{customerIdsForPhone}=await import('../lib/customer-search.ts');
 assert.deepEqual((await customerIdsForPhone(makeD1(sqlite),'9708563488')).sort(),['crm-only','older']);
 assert.equal(await customerIdsForPhone(makeD1(sqlite),'QA Booking'),null);
});
