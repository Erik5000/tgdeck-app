import { sessionAuthorization } from './http-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer } from '../src/server.ts';
import { DemoSource } from '../src/demo.ts';
import type { ServerEvent, Snapshot } from '../src/protocol.ts';

async function setup(t: TestContext) {
  const source = new DemoSource({ intervalMs: 0 });
  const app = await startServer({ port: 0, source });
  t.after(() => app.close());
  const login = await fetch(app.url, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const header = login.headers.get('set-cookie')!;
  const authorization = sessionAuthorization(login);
  return { ...app, source, authorization, header };
}

test('bootstrap is single-use and puts the credential only in the redirect fragment', async t => {
  const app = await setup(t);
  assert.match(app.header, /HttpOnly/);
  assert.match(app.header, /Max-Age=0/);
  assert.ok(!app.header.includes(app.authorization.slice(7)));
  assert.equal((await fetch(app.origin + '/api/state', { headers: { Cookie: `tgdeck_${new URL(app.origin).port}=${app.authorization.slice(7)}` } })).status, 401);
  assert.equal((await fetch(app.url, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  const state = await fetch(app.origin + '/api/state', { headers: { Authorization: app.authorization } });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('cache-control'), 'no-store');
});

test('only the generic shell is public; account, SSE and media requests require a bearer', async t => {
  const app = await setup(t);
  for (const path of ['/', '/app.js', '/api.js', '/avatars.js']) assert.equal((await fetch(app.origin + path)).status, 200);
  for (const path of ['/api/events', '/api/state', '/api/avatars/1', '/media/1']) {
    assert.equal((await fetch(app.origin + path)).status, 401);
  }
});

test('exact Host checks reject rebinding, missing ports and arbitrary local names', async t => {
  const app = await setup(t);
  for (const host of ['evil.invalid', '127.0.0.1', 'localhost.evil.invalid:4310']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(app.origin + '/api/state', { headers: { Host: host, Authorization: app.authorization } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  }
});

test('mutations require exact Origin and reject cross-site requests and payloads', async t => {
  const app = await setup(t);
  for (const origin of [undefined, 'https://evil.invalid', 'null']) {
    const headers: Record<string, string> = { Authorization: app.authorization };
    if (origin) headers.Origin = origin;
    const response = await fetch(app.origin + '/api/demo/board', { method: 'POST', headers });
    assert.equal(response.status, 403);
  }
  assert.equal((await fetch(app.origin + '/api/state', { headers: { Authorization: app.authorization, Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(app.origin + '/api/demo/board', { method: 'POST', headers: { Authorization: app.authorization, Origin: app.origin }, body: '{}' })).status, 400);
  const allowed = await fetch(app.origin + '/api/demo/board', { method: 'POST', headers: { Authorization: app.authorization, Origin: app.origin } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).columns.length, 4);
});

test('only allowlisted assets are served with a strict CSP and no untrusted HTML', async t => {
  const app = await setup(t);
  const headers = { Authorization: app.authorization };
  for (const path of ['/.git/config', '/src/protocol.ts', '/package.json', '/%2e%2e%2fLICENSE', '/api/send']) {
    assert.equal((await fetch(app.origin + path, { headers })).status, 404);
  }
  const response = await fetch(app.origin, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.ok(!response.headers.get('content-security-policy')!.includes('unsafe-inline'));
  const script = await fetch(app.origin + '/render.js', { headers });
  assert.ok(!(await script.text()).includes('innerHTML'));
});

test('SSE starts with a fresh snapshot and broadcasts updates to authenticated clients', async t => {
  const app = await setup(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(app.origin + '/api/events', { headers: { Authorization: app.authorization }, signal: abort.signal });
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /"type":"snapshot"/);
  assert.match(initial, /"columns":\[\]/);
  app.source.loadBoard();
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /demo-inspiration/);
  app.source.tick();
  const live = new TextDecoder().decode((await reader.read()).value);
  assert.match(live, /"type":"message"/);
  await reader.cancel();
});

class LargeSnapshotSource extends DemoSource {
  override snapshot(): Snapshot {
    const chat = { id: 'demo-large', title: 'Synthetic Archive', type: 'group' as const, canSend: false };
    const messages = Array.from({ length: 50 }, (_, index) => ({
      key: `${chat.id}:${index}`, id: String(index), chat, sender: { name: 'Synthetic Sender' },
      date: 1800000000, edited: false, own: false, text: 'x'.repeat(4096), entities: [],
    }));
    return { ...super.snapshot(), columns: [{ id: 'large', title: chat.title, width: 'medium', filter: { type: 'chat', chatId: chat.id } }], feeds: { large: messages } };
  }
}

test('SSE delivers a snapshot that is larger than the socket buffer', async t => {
  const app = await startServer({ port: 0, source: new LargeSnapshotSource({ intervalMs: 0 }) });
  t.after(() => app.close());
  const login = await fetch(app.url, { redirect: 'manual' });
  const authorization = sessionAuthorization(login);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(app.origin + '/api/events', { headers: { Authorization: authorization }, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.endsWith('\n\n')) {
    const { done, value } = await reader.read();
    assert.ok(!done, 'The server closed the stream before the snapshot was complete.');
    text += decoder.decode(value, { stream: true });
  }
  const event = JSON.parse(text.slice('data: '.length)) as ServerEvent;
  assert.equal(event.type, 'snapshot');
  if (event.type === 'snapshot') assert.equal(event.data.feeds.large!.length, 50);
  await reader.cancel();
});

test('a session from another server instance cannot authenticate', async t => {
  const first = await setup(t);
  const second = await setup(t);
  assert.equal((await fetch(second.origin + '/api/state', { headers: { Authorization: first.authorization } })).status, 401);
});
