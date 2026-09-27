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
