import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Td from 'tdlib-types';
import { TelegramSource } from '../src/telegram.ts';
import { FakeTelegram, demoChat } from './telegram-fixture.ts';

const chat = (id: number, title: string) => ({ ...demoChat, id, title }) as Td.chat;
const older = chat(-100010, 'Older Synthetic Group');
const archived = chat(-100011, 'Archived Synthetic Group');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-search-'));
  const fake = new FakeTelegram();
  const source = new TelegramSource(directory, { factory: async () => fake.client });
  t.after(async () => { await source.close(); await rm(directory, { recursive: true, force: true }); });
  await source.start();
  await source.setup({ apiId: 1234, apiHash: 'a'.repeat(32) });
  await fake.auth({ _: 'authorizationStateReady' });
  const titles = async (query: string) => (await source.listChats(query)).map(item => item.title);
  const loads = () => fake.requests.filter(query => query._ === 'loadChats').length;
  return { source, fake, titles, loads };
}

test('search finds chats beyond the first page of the main list', async t => {
  const { fake, titles } = await fixture(t);
  fake.unloaded.set('chatListMain', [[], [older]]);
  assert.deepEqual(await titles('Older'), [older.title]);
});

test('search finds archived chats', async t => {
  const { fake, titles } = await fixture(t);
  fake.unloaded.set('chatListArchive', [[archived]]);
  assert.deepEqual(await titles('Archived'), [archived.title]);
});

test('concurrent and later searches load the chat lists once', async t => {
  const { fake, titles, loads } = await fixture(t);
  fake.unloaded.set('chatListMain', [[older]]);
  fake.unloaded.set('chatListArchive', [[archived]]);
  await Promise.all([titles('Older'), titles('Archived')]);
  const count = loads();
  assert.ok(count > 0);
  await titles('Synthetic');
  assert.equal(loads(), count);
});

test('a failed chat list load still searches known chats, and the next search tries again', async t => {
  const { fake, titles } = await fixture(t);
  fake.failureMethod = 'loadChats';
  fake.failure = { code: 500, message: 'Synthetic load failure' };
  assert.deepEqual(await titles('Studio'), [demoChat.title]);
  fake.failure = undefined;
  fake.unloaded.set('chatListMain', [[older]]);
  assert.deepEqual(await titles('Older'), [older.title]);
});

test('the chat list load stops at a page limit', async t => {
  const { fake, titles, loads } = await fixture(t);
  fake.unloaded.set('chatListMain', Array.from({ length: 500 }, () => []));
  await titles('Studio');
  assert.ok(loads() < 500);
});

test('opening the picker without a query loads only one page', async t => {
  const { fake, titles, loads } = await fixture(t);
  fake.unloaded.set('chatListMain', [[], [older]]);
  await titles('');
  assert.equal(loads(), 1);
});
