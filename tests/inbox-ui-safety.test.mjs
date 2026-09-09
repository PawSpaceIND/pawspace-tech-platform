import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inboxResponseError,inboxErrorMessage} from '../lib/inbox-ui-error.ts';

test('inbox never exposes unexpected backend or network diagnostics',()=>{
  for(const cause of [new Error('HTTP 500 SQL secret stack'), 'TypeError: fetch failed', {message:'internal credential'}]) {
    assert.equal(inboxErrorMessage(cause), "We couldn't confirm the latest update. Check your connection and review the conversation before retrying.");
  }
  for(const status of [400,401,403,404,409,429,500,503]) {
    const message=inboxErrorMessage(inboxResponseError(status));
    assert.doesNotMatch(message,/HTTP|SQL|stack|\b[45]\d\d\b/);
    assert.ok(message.length>20);
  }
});

test('source contract: thread switches clear prior context and late responses check selection',()=>{
  const source=readFileSync('app/team/customer-experience/page.tsx','utf8');
  assert.match(source,/selectedRef\.current !== id/);
  assert.match(source,/shouldApply\(\) && selectedRef\.current === id/);
  assert.match(source,/selectedRef\.current = row\.id;[\s\S]*setConversation\(null\);[\s\S]*setControl\(null\);[\s\S]*setReply\(""\);/);
  assert.doesNotMatch(source,/HTTP \$\{|setError\(cause instanceof Error/);
  assert.match(source,/role="alert"/);
  const template=readFileSync('app/team/customer-experience/template.tsx','utf8');
  assert.doesNotMatch(template,/key=\{revision\}|setInterval|"use client"/);
});
