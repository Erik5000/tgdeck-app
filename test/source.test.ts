import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoSource } from '../src/demo.ts';
import type { ServerEvent } from '../src/protocol.ts';

test('demo starts empty and loads four invented column types idempotently', () => {
  const source = new DemoSource({ intervalMs: 0, now: () => 1800000000000 });
  assert.equal(source.snapshot().columns.length, 0);
  source.loadBoard();
  const snapshot = source.snapshot();
  assert.deepEqual(snapshot.columns.map(column => column.filter.type), ['folder', 'chat', 'search', 'mentions']);
  source.loadBoard();
  assert.deepEqual(source.snapshot(), snapshot);
  for (const column of snapshot.columns) {
    const messages = snapshot.feeds[column.id]!;
    assert.ok(messages.length > 0);
    for (const message of messages) assert.ok(message.chat.id.startsWith('demo-'));
    if (column.filter.type === 'search') assert.ok(messages.every(message => message.text.toLowerCase().includes('design')));
    if (column.filter.type === 'mentions') assert.ok(messages.every(message => message.mentioned));
    for (let index = 1; index < messages.length; index++) {
      assert.ok(column.filter.type === 'chat' ? messages[index]!.date >= messages[index - 1]!.date : messages[index]!.date <= messages[index - 1]!.date);
    }
  }
  source.close();
});

test('snapshots cannot mutate source state; live history and subscribers are bounded', () => {
  const source = new DemoSource({ intervalMs: 0 });
  const updates: ServerEvent[] = [];
  const unsubscribe = source.subscribe(event => updates.push(event));
  source.loadBoard();
  const snapshot = source.snapshot();
  snapshot.columns[0]!.title = 'changed outside';
  assert.equal(source.snapshot().columns[0]!.title, 'Inspiration');
  for (let i = 0; i < 500; i++) source.tick();
  assert.ok(Object.values(source.snapshot().feeds).every(messages => messages.length <= 50 && messages.length > 0));
  assert.ok(updates.some(update => update.type === 'message'));
  unsubscribe();
  const count = updates.length;
  source.tick();
  assert.equal(updates.length, count);
  source.clearBoard();
  source.tick();
  assert.deepEqual(source.snapshot().feeds, {});
  source.close();
});
