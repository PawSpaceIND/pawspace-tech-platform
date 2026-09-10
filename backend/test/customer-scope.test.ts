import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildApp} from '../src/app.js';
import {MemoryRepository} from '../src/repository.js';
import {issueSession} from '../src/auth.js';
import type {Role} from '../src/domain.js';

test('signed staff customer access is city-scoped; global admin retains explicit access',async t=>{
 const before={NODE_ENV:process.env.NODE_ENV,AUTH_MODE:process.env.AUTH_MODE,API_SECRET:process.env.API_SECRET};
 t.after(()=>{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.NODE_ENV='production';process.env.AUTH_MODE='token';process.env.API_SECRET='isolated-customer-scope-regression-key-only';
 const repository=new MemoryRepository();const app=buildApp(repository);t.after(()=>app.close());
 const token=(role:Role,cityId:string,id='staff')=>({authorization:`Bearer ${issueSession({id,role,cityId}).accessToken}`});
 for(const role of ['sales','operations','finance','city_admin','auditor'] as Role[]){
  const denied=await app.inject({url:'/v1/customers/cus_10428/360',headers:token(role,'chennai')});assert.equal(denied.statusCode,403,role);assert.equal(denied.json().data,undefined);
  const allowed=await app.inject({url:'/v1/customers/cus_10428/360',headers:token(role,'blr')});assert.equal(allowed.statusCode,200,role);
 }
 assert.equal((await app.inject({url:'/v1/customers/cus_10428/360',headers:token('super_admin','chennai')})).statusCode,200);
 assert.equal((await app.inject({url:'/v1/customers/cus_10428/communication-preferences',headers:token('provider','blr')})).statusCode,403);
 assert.equal((await app.inject({url:'/v1/customers/cus_10428/communication-preferences',headers:token('customer','blr','other-customer')})).statusCode,403);
 assert.equal((await app.inject({url:'/v1/customers/cus_10428/communication-preferences',headers:token('customer','blr','cus_10428')})).statusCode,200);
 assert.equal((await app.inject({url:'/v1/customers/cus_10428/communication-preferences',headers:token('operations','chennai')})).statusCode,403);
 const petsBefore=(await repository.listPets('cus_10428')).length;
 assert.equal((await app.inject({method:'POST',url:'/v1/pets',headers:token('operations','chennai'),payload:{customerId:'cus_10428',name:'Blocked pet',species:'dog'}})).statusCode,403);
 assert.equal((await repository.listPets('cus_10428')).length,petsBefore);
});
