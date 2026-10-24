import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArrivalTracker } from '../web/arrivals.js';

test('offscreen arrivals wait until seen before their highlight expires', () => {
  const arrivals = new ArrivalTracker();
  arrivals.add('invented-message');
  arrivals.retain(['invented-message'], 60000);
  assert.equal(arrivals.has('invented-message'), true);
  arrivals.seen('invented-message', 60000);
  arrivals.retain(['invented-message'], 71999);
  assert.equal(arrivals.has('invented-message'), true);
  arrivals.retain(['invented-message'], 72000);
  assert.equal(arrivals.has('invented-message'), false);
});

test('duplicate updates and repeated visibility do not extend an arrival', () => {
  const arrivals = new ArrivalTracker();
  arrivals.add('invented-message');
  arrivals.seen('invented-message', 1000);
  arrivals.add('invented-message');
  arrivals.seen('invented-message', 12000);
  arrivals.retain(['invented-message'], 13000);
  assert.equal(arrivals.size, 0);
});

test('an ID replacement preserves the original highlight deadline', () => {
  const arrivals = new ArrivalTracker();
  arrivals.add('invented-old');
  arrivals.seen('invented-old', 1000);
  arrivals.replace('invented-old', 'invented-final');
  assert.equal(arrivals.has('invented-old'), false);
  arrivals.retain(['invented-final'], 12999);
  assert.equal(arrivals.has('invented-final'), true);
  arrivals.retain(['invented-final'], 13000);
  assert.equal(arrivals.size, 0);
});

test('deleted, trimmed and closed-feed arrivals cannot accumulate', () => {
  const arrivals = new ArrivalTracker();
  for (let index = 0; index < 1000; index++) arrivals.add(`invented-${index}`);
  assert.equal(arrivals.size, 50);
  assert.equal(arrivals.has('invented-0'), false);
  arrivals.retain(['invented-999'], 0);
  assert.equal(arrivals.size, 1);
  arrivals.retain([], 0);
  assert.equal(arrivals.size, 0);
});
