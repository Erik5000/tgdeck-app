import { sessionAuthorization } from './http-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSettings, validateSettings, validatePreferences } from '../src/preferences.ts';
import { TelegramSource } from '../src/telegram.ts';
import { DemoSource } from '../src/demo.ts';
import { FakeTelegram, demoChat, secondChat } from './telegram-fixture.ts';
import { readPrivateJson, writePrivateJson } from '../src/storage.ts';
import { startServer } from '../src/server.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-preferences-'));
  const fake = new FakeTelegram();
  const source = new TelegramSource(directory, { factory: async () => fake.client });
  t.after(async () => { await source.close(); await rm(directory, { recursive: true, force: true }); });
  await source.start();
  await source.setup({ apiId: 1234, apiHash: 'a'.repeat(32) });
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  await source.addChat(String(secondChat.id));
  return { directory, fake, source };
}

test('display settings accept only supported complete values', () => {
  validateSettings(defaultSettings);
  for (const value of [{}, [], { ...defaultSettings, theme: 'custom' }, { ...defaultSettings, fontSize: 999 },
    { ...defaultSettings, accent: 'url(https://example.invalid)' }, { ...defaultSettings, profilePictures: 'true' },
    { ...defaultSettings, extra: true }, { ...defaultSettings, layout: 'constructor' }]) assert.throws(() => validateSettings(value));
  assert.throws(() => validatePreferences({ settings: defaultSettings, columns: [{ id: '../private', width: 'wide' }], layouts: [] }));
});

test('saved layouts restore chats, order, widths and arrangement without replacing colors', async t => {
  const { source, directory } = await fixture(t);
  const first = `live-${demoChat.id}`;
  const second = `live-${secondChat.id}`;
  await source.updateColumn(second, { move: 'left' });
  await source.updateColumn(second, { width: 'wide' });
  await source.updateSettings({ ...defaultSettings, layout: 'grid', fontSize: 16, profilePictures: true });
  await source.saveLayout({ name: 'Fictional overview' });
  const saved = source.snapshot().layouts![0]!;
  await source.removeColumn(second);
  await source.updateSettings({ ...defaultSettings, accent: 'ocean' });
  await source.applyLayout(saved.id);
  assert.deepEqual(source.snapshot().columns.map(column => [column.id, column.width]), [[second, 'wide'], [first, 'medium']]);
  assert.equal(source.snapshot().settings!.layout, 'grid');
  assert.equal(source.snapshot().settings!.accent, 'ocean');
  const raw = await readPrivateJson(directory, 'columns.json') as { workspace: unknown };
  validatePreferences(raw.workspace);
  const restarted = new TelegramSource(directory, { factory: async () => new FakeTelegram().client });
  t.after(() => restarted.close());
  await restarted.start();
  assert.deepEqual(restarted.snapshot().settings, source.snapshot().settings);
  assert.deepEqual(restarted.snapshot().layouts, source.snapshot().layouts);
  await source.deleteLayout(saved.id);
  assert.equal(source.snapshot().layouts!.length, 0);
  assert.equal(source.snapshot().columns.length, 2);
});

test('an unavailable saved chat leaves the active board and saved file unchanged', async t => {
  const { source, fake, directory } = await fixture(t);
  await source.saveLayout({ name: 'Fictional pair' });
  const id = source.snapshot().layouts![0]!.id;
  await source.removeColumn(`live-${secondChat.id}`);
  fake.chats.delete(secondChat.id);
  const before = source.snapshot();
  const saved = await readPrivateJson(directory, 'columns.json');
  await assert.rejects(source.applyLayout(id));
  assert.deepEqual(source.snapshot(), before);
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), saved);
});

test('changing settings before login preserves the legacy saved board', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-before-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writePrivateJson(directory, 'columns.json', { chatId: String(demoChat.id) });
  const source = new TelegramSource(directory);
  t.after(() => source.close());
  await source.start();
  await source.updateSettings({ ...defaultSettings, theme: 'dark' });
  const saved = await readPrivateJson(directory, 'columns.json') as { chatIds: string[] };
  assert.deepEqual(saved.chatIds, [String(demoChat.id)]);
});

test('layout count, column widths and move bounds are enforced', async () => {
  const source = new DemoSource({ intervalMs: 0 });
  source.loadBoard();
  const first = source.snapshot().columns[0]!.id;
  await source.updateColumn(first, { move: 'left' });
  assert.equal(source.snapshot().columns[0]!.id, first);
  await assert.rejects(source.updateColumn(first, { width: '9999px' }));
  await assert.rejects(source.updateColumn(first, { width: ['wide'] }));
  assert.throws(() => validatePreferences({ settings: defaultSettings, columns: [{ id: first, width: ['wide'] }], layouts: [] }));
  await assert.rejects(source.updateColumn('demo-missing', { width: 'wide' }));
  for (let i = 0; i < 12; i++) await source.saveLayout({ name: `Fictional layout ${i + 1}` });
  await assert.rejects(source.saveLayout({ name: 'Too many layouts' }));
  assert.equal(source.snapshot().layouts!.length, 12);
  source.close();
});

test('drop reordering moves across several columns and preserves widths and feeds', async t => {
  const source = new DemoSource({ intervalMs: 0 });
  t.after(() => source.close());
  source.loadBoard();
  const [first, second, third, fourth] = source.snapshot().columns.map(column => column.id) as [string, string, string, string];
  await source.updateColumn(first, { width: 'wide' });
  const feeds = source.snapshot().feeds;
  await source.updateColumn(first, { beforeId: fourth });
  assert.deepEqual(source.snapshot().columns.map(column => column.id), [second, third, first, fourth]);
  await source.updateColumn(fourth, { beforeId: second });
  assert.deepEqual(source.snapshot().columns.map(column => column.id), [fourth, second, third, first]);
  await source.updateColumn(fourth, { beforeId: null });
  assert.deepEqual(source.snapshot().columns.map(column => column.id), [second, third, first, fourth]);
  assert.equal(source.snapshot().columns.find(column => column.id === first)?.width, 'wide');
  assert.deepEqual(source.snapshot().feeds, feeds);
});

test('invalid or stale drop destinations leave the board unchanged', async t => {
  const source = new DemoSource({ intervalMs: 0 });
  t.after(() => source.close());
  source.loadBoard();
  const id = source.snapshot().columns[0]!.id;
  const before = source.snapshot();
  for (const body of [{ beforeId: 'demo-missing' }, { beforeId: '' }, { beforeId: 0 }, { beforeId: [] },
    { beforeId: '../private' }, { beforeId: null, move: 'left' }]) {
    await assert.rejects(source.updateColumn(id, body));
    assert.deepEqual(source.snapshot(), before);
  }
  await source.updateColumn(id, { beforeId: id });
  assert.deepEqual(source.snapshot(), before);
});

test('a dropped live column keeps its position after restarting', async t => {
  const { source, directory } = await fixture(t);
  const first = `live-${demoChat.id}`;
  const second = `live-${secondChat.id}`;
  await source.updateColumn(first, { width: 'wide' });
  await source.updateColumn(first, { beforeId: null });
  await source.close();
  const fake = new FakeTelegram();
  const restarted = new TelegramSource(directory, { factory: async () => fake.client });
  t.after(() => restarted.close());
  await restarted.start();
  await fake.auth({ _: 'authorizationStateReady' });
  const deadline = Date.now() + 2000;
  while (restarted.snapshot().columns.length !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(restarted.snapshot().columns.map(({ id, width }) => [id, width]), [[second, 'medium'], [first, 'wide']]);
});

test('settings, layouts, column options and avatar routes retain authentication and Origin checks', async t => {
  const source = new DemoSource({ intervalMs: 0 }); source.loadBoard();
  const app = await startServer({ port: 0, source });
  t.after(() => app.close());
  const login = await fetch(app.url, { redirect: 'manual' });
  const authorization = sessionAuthorization(login);
  for (const [path, method, body] of [['/api/settings', 'PUT', defaultSettings], ['/api/layouts', 'POST', { name: 'Fictional layout' }],
    ['/api/columns/demo-chat', 'PATCH', { width: 'wide' }], ['/api/columns/demo-chat', 'PATCH', { beforeId: null }]] as const) {
    assert.equal((await fetch(app.origin + path, { method, body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(app.origin + path, { method, headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
    const response = await fetch(app.origin + path, { method, headers: { Authorization: authorization, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  }
  const avatar = app.origin + '/api/avatars/demo-mika';
  assert.equal((await fetch(avatar)).status, 401);
  assert.equal((await fetch(avatar, { headers: { Authorization: authorization } })).status, 404);
  await source.updateSettings({ ...defaultSettings, profilePictures: true });
  const picture = await fetch(avatar, { headers: { Authorization: authorization } });
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/svg+xml');
  assert.equal(picture.headers.get('cache-control'), 'no-store');
});
