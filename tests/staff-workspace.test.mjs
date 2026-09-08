import test from 'node:test';
import assert from 'node:assert/strict';
import {staffWorkspace} from '../lib/staff-workspace.ts';

test('staff landing routes keep management out of employee-only self-service',()=>{
  for(const role of ['founder','finance','manager','associate','superuser']) {
    assert.equal(staffWorkspace(role),'/team');
  }
  assert.equal(staffWorkspace('service_provider'),'/me');
  assert.equal(staffWorkspace(undefined),'/team');
  assert.equal(staffWorkspace('https://example.com'),'/team');
});
