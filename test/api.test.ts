import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedRequest, readEvents, apiFetch, onUnauthorized } from '../web/api.js';

test('API credentials are explicit headers restricted to the exact app origin', () => {
  const origin = 'http://127.0.0.1:4310';
  const request = authenticatedRequest('/api/state', { credentials: 'include', redirect: 'follow' }, origin, 'synthetic-session');
  assert.equal(request.url.href, `${origin}/api/state`);
  assert.equal(request.init.headers.get('Authorization'), 'Bearer synthetic-session');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.cache, 'no-store');
  for (const path of ['http://127.0.0.1:4311/api/state', 'http://localhost:4310/api/state', '//example.invalid/api/state', '/app.js']) {
    assert.throws(() => authenticatedRequest(path, {}, origin, 'synthetic-session'));
  }
});

test('authenticated event parsing preserves split UTF-8, frames and heartbeat comments', async () => {
  const expected = [{ type: 'columnError', columnId: 'demo-🌱', code: 'unavailable' }, { type: 'connection', connection: 'connected' }];
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(expected[0])}\n\n: keepalive\n\ndata: ${JSON.stringify(expected[1])}\n\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events: unknown[] = [];
  await readEvents(stream, event => events.push(event));
  assert.deepEqual(events, expected);
});

test('invalid event data cancels its reader instead of retaining the stream', async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: invalid\n\n')); }, cancel() { canceled = true; } });
  await assert.rejects(readEvents(stream, () => {}));
  assert.equal(canceled, true);
});

test('an unauthorized mutation ends the session even without an event stream', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://127.0.0.1:4310' } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else Reflect.deleteProperty(globalThis, 'location');
    onUnauthorized(() => {});
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  let ended = false;
  onUnauthorized(() => { ended = true; });
  assert.equal((await apiFetch('/api/settings', { method: 'PUT' })).status, 401);
  assert.equal(ended, true);
});
