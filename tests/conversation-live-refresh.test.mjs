import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeConversationRefresh } from '../lib/conversation-live-refresh.ts';

test('CX reconnect backfills, duplicate versions dedupe and disposed pages stop refreshing', () => {
  const source = new EventTarget();
  let closed = 0, refreshes = 0;
  source.close = () => closed++;
  const stop = subscribeConversationRefresh(() => refreshes++, () => source);
  const emit = (name, version) => source.dispatchEvent(new MessageEvent(name, {data: JSON.stringify({version})}));
  emit('ready', 100); emit('conversation', 101); emit('conversation', 101); emit('conversation', 99);
  assert.equal(refreshes, 2);
  emit('ready', 101); // A reconnected stream must backfill even without a newer wall clock.
  assert.equal(refreshes, 3);
  emit('ready', 90); emit('conversation', 91);
  assert.equal(refreshes, 5);
  for (const bad of [-1, 1.5, '102', null]) emit('conversation', bad);
  source.dispatchEvent(new MessageEvent('conversation', {data: '{invalid'}));
  assert.equal(refreshes, 5);
  stop(); emit('conversation', 200);
  assert.equal(refreshes, 5);
  assert.equal(closed, 1);
});
