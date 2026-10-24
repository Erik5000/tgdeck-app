import { sessionAuthorization } from './http-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.ts';
import { TelegramSource } from '../src/telegram.ts';
import { FakeTelegram, demoChat, secondChat } from './telegram-fixture.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-login-http-'));
  const fake = new FakeTelegram();
  const source = new TelegramSource(directory, { factory: async () => fake.client });
  await source.start();
  const app = await startServer({ port: 0, source });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const auth = await fetch(app.url, { redirect: 'manual' });
  const authorization = sessionAuthorization(auth);
  const headers = { Authorization: authorization, Origin: app.origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(app.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, source, fake, headers, post };
}

test('setup/auth endpoints preserve bearer and Origin protections and body limits', async t => {
  const { app, headers, post } = await fixture(t);
  const setup = { apiId: 1234, apiHash: 'b'.repeat(32) };
  assert.equal((await fetch(app.origin + '/api/setup', { method: 'POST', body: JSON.stringify(setup) })).status, 401);
  assert.equal((await fetch(app.origin + '/api/setup', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: JSON.stringify(setup) })).status, 403);
  for (const body of [{ ...setup, extra: 'unexpected' }, { apiId: -1, apiHash: setup.apiHash }, [], { apiId: 1234, apiHash: 'short' }]) {
    assert.equal((await post('/api/setup', body)).status, 400);
  }
  assert.equal((await post('/api/auth', { step: 'password', value: 'x'.repeat(9000) })).status, 400);
  assert.equal((await post('/api/setup', setup)).status, 200);
});

test('auth failures are fixed messages and live/demo routes remain isolated', async t => {
  const { app, fake, headers, post } = await fixture(t);
  await post('/api/setup', { apiId: 1234, apiHash: 'c'.repeat(32) });
  await fake.auth({ _: 'authorizationStateWaitPhoneNumber' });
  fake.failure = { code: 400, message: 'a private phone and name' };
  const failed = await post('/api/auth', { step: 'phone', value: '+' + '491234567890' });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'unavailable' });
  fake.failure = undefined;
  assert.equal((await post('/api/demo/board', {})).status, 404);
  assert.equal((await fetch(app.origin + '/api/chats', { headers })).status, 409);
  await fake.auth({ _: 'authorizationStateReady' });
  assert.equal((await fetch(app.origin + '/api/chats', { headers })).status, 200);
  const selected = await post('/api/columns', { chatId: String(demoChat.id) });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).columns.length, 1);
  assert.equal((await post('/api/send', { text: 'Missing request and chat IDs' })).status, 400);
});

test('column endpoints append and remove only the requested column with bearer and Origin protection', async t => {
  const { app, fake, headers, post } = await fixture(t);
  await post('/api/setup', { apiId: 1234, apiHash: 'd'.repeat(32) });
  await fake.auth({ _: 'authorizationStateReady' });
  await post('/api/columns', { chatId: String(demoChat.id) });
  const added = await post('/api/columns', { chatId: String(secondChat.id) });
  const snapshot = await added.json();
  assert.equal(snapshot.columns.length, 2);
  const path = `/api/columns/${snapshot.columns[0].id}`;
  assert.equal((await fetch(app.origin + path, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(app.origin + path, { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(app.origin + path, { method: 'DELETE', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(app.origin + '/api/columns/invalid', { method: 'DELETE', headers })).status, 400);
  const removed = await fetch(app.origin + path, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).columns.map((column: { id: string }) => column.id), [snapshot.columns[1].id]);
  assert.equal((await fetch(app.origin + path, { method: 'DELETE', headers })).status, 404);
});

test('sending enforces bearer, Origin and body validation before invoking Telegram', async t => {
  const { app, source, fake, headers, post } = await fixture(t);
  await source.setup({ apiId: 1234, apiHash: 'a'.repeat(32) });
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  const body = { requestId: randomUUID(), chatId: String(demoChat.id), text: '界'.repeat(4096) };
  const url = app.origin + '/api/send';
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: JSON.stringify(body) })).status, 403);
  const { Origin: _origin, ...noOrigin } = headers;
  assert.equal((await fetch(url, { method: 'POST', headers: noOrigin, body: JSON.stringify(body) })).status, 403);
  for (const invalid of [{ ...body, extra: true }, { ...body, text: '' }, { ...body, text: 'x'.repeat(33000) },
    { ...body, replyTo: { chatId: String(secondChat.id), messageId: '1' } },
  ]) assert.equal((await post('/api/send', invalid)).status, 400);
  assert.equal(fake.sent.length, 0);
  const sent = await post('/api/send', body);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { accepted: true });
  assert.equal((await post('/api/send', body)).status, 200);
  assert.equal(fake.sent.length, 1);
});
