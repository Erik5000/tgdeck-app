import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Td from 'tdlib-types';
import { TelegramSource, authState } from '../src/telegram.ts';
import { telegramError, OperationError } from '../src/errors.ts';
import { loadConfig, readPrivateJson, writePrivateJson } from '../src/storage.ts';
import { convertMessage, convertChat } from '../src/convert.ts';
import { FakeTelegram, demoChat, secondChat, fakeMessage } from './telegram-fixture.ts';
import type { ServerEvent } from '../src/protocol.ts';

const credentials = { apiId: 1234, apiHash: 'a'.repeat(32) };

async function sourceFixture(t: TestContext, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-auth-'));
  const fake = new FakeTelegram();
  const source = new TelegramSource(directory, { factory: async () => fake.client, now });
  t.after(async () => { await source.close(); await rm(directory, { recursive: true, force: true }); });
  await source.start();
  return { source, fake, directory };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected synthetic operation to complete');
}

test('auth state conversion omits phone, hints, email patterns and other-device tokens', () => {
  const phone = '+' + '491234567890';
  const state = authState({ _: 'authorizationStateWaitCode', code_info: {
    _: 'authenticationCodeInfo', phone_number: phone, type: { _: 'authenticationCodeTypeTelegramMessage', length: 5 }, timeout: 30,
  } });
  assert.deepEqual(state, { state: 'code', delivery: 'telegram' });
  assert.deepEqual(authState({ _: 'authorizationStateWaitPassword', password_hint: 'private hint', has_recovery_email_address: true, has_passport_data: false, recovery_email_address_pattern: 'private email' }), { state: 'password' });
  assert.deepEqual(authState({ _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=private' }), { state: 'unsupported', reason: 'deviceConfirmation' });
  assert.deepEqual(authState({ _: 'authorizationStateWaitRegistration', terms_of_service: {} } as Td.authorizationStateWaitRegistration), { state: 'unsupported', reason: 'registration' });
});

test('setup persists only private config and snapshots contain no API details', async t => {
  const { source, fake, directory } = await sourceFixture(t);
  assert.equal(source.snapshot().auth.state, 'setup');
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateWaitTdlibParameters' });
  const deadline = Date.now() + 2000;
  while (!fake.requests.some(request => request._ === 'setTdlibParameters') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(fake.requests.some(request => request._ === 'setTdlibParameters'), 'Expected TDLib initialization request');
  const parameters = fake.requests.find(request => request._ === 'setTdlibParameters')!;
  assert.equal(parameters.api_id, credentials.apiId);
  assert.equal(parameters.use_secret_chats, false);
  assert.ok(String(parameters.database_directory).startsWith(directory));
  const saved = await loadConfig(directory);
  assert.equal(saved!.apiHash, credentials.apiHash);
  assert.equal((await stat(join(directory, 'config.json'))).mode & 0o777, 0o600);
  const snapshot = JSON.stringify(source.snapshot());
  assert.ok(!snapshot.includes(credentials.apiHash));
  assert.ok(!snapshot.includes(saved!.databaseKey));
});

test('auth inputs route to the correct TDLib methods and are never persisted', async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  const phone = '+' + '491234567890';
  await fake.auth({ _: 'authorizationStateWaitPhoneNumber' });
  await source.submitAuth({ step: 'phone', value: phone });
  assert.equal(fake.requests.at(-1)!._, 'setAuthenticationPhoneNumber');
  await fake.auth({ _: 'authorizationStateWaitCode', code_info: { _: 'authenticationCodeInfo', phone_number: phone, type: { _: 'authenticationCodeTypeSms', length: 5 }, timeout: 30 } });
  await source.submitAuth({ step: 'code', value: '54321' });
  await fake.auth({ _: 'authorizationStateWaitPassword', password_hint: 'ignore', has_recovery_email_address: false, has_passport_data: false, recovery_email_address_pattern: '' });
  await source.submitAuth({ step: 'password', value: ' fictional password ' });
  assert.equal(fake.requests.at(-1)!.password, ' fictional password ');
  await fake.auth({ _: 'authorizationStateWaitEmailAddress', allow_apple_id: false, allow_google_id: false });
  await source.submitAuth({ step: 'email', value: 'person@example.invalid' });
  await fake.auth({ _: 'authorizationStateWaitEmailCode' } as Td.authorizationStateWaitEmailCode);
  await source.submitAuth({ step: 'emailCode', value: '98765' });
  assert.deepEqual(fake.requests.at(-1)!.code, { _: 'emailAddressAuthenticationCode', code: '98765' });
  const saved = await readFile(join(directory, 'config.json'), 'utf8');
  for (const secret of [phone, '54321', 'fictional password', 'person@example.invalid', '98765']) assert.ok(!saved.includes(secret));
  assert.deepEqual((await readdir(directory)).sort(), ['config.json']);
});

test('wrong steps and concurrent auth are rejected; SDK errors are redacted and flood waits enforced', async t => {
  let now = 1000;
  const { source, fake } = await sourceFixture(t, () => now);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateWaitPhoneNumber' });
  await assert.rejects(source.submitAuth({ step: 'code', value: '12345' }), { code: 'invalidState' });
  let release!: () => void;
  fake.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = source.submitAuth({ step: 'phone', value: '+' + '491234567890' });
  await assert.rejects(source.submitAuth({ step: 'phone', value: '+' + '491234567890' }), { code: 'invalidState' });
  release(); await pending; fake.hold = undefined;
  fake.failure = { code: 400, message: 'FLOOD_WAIT_20' };
  await assert.rejects(source.submitAuth({ step: 'phone', value: '+' + '491234567890' }), { code: 'rateLimited', retryAfter: 20 });
  const count = fake.requests.length;
  await assert.rejects(source.submitAuth({ step: 'phone', value: '+' + '491234567890' }), { code: 'rateLimited' });
  assert.equal(fake.requests.length, count);
  now += 21000;
  fake.failure = { code: 400, message: 'a sensitive message and phone value' };
  await assert.rejects(source.submitAuth({ step: 'phone', value: '+' + '491234567890' }), { message: 'unavailable' });
});

test('registration never submits a name and allows changing the phone explicitly', async t => {
  const { source, fake } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateWaitRegistration' } as Td.authorizationStateWaitRegistration);
  assert.deepEqual(source.snapshot().auth, { state: 'unsupported', reason: 'registration' });
  await source.submitAuth({ step: 'phone', value: '+' + '491234567890' });
  assert.ok(!fake.requests.some(request => request._ === 'registerUser'));
});

test('sessions load privately on restart, malformed config and symlink aliases fail closed', async t => {
  const { source, directory } = await sourceFixture(t);
  await source.setup(credentials);
  const restarted = new TelegramSource(directory, { factory: async () => new FakeTelegram().client });
  t.after(() => restarted.close());
  await restarted.start();
  assert.equal(restarted.snapshot().auth.state, 'starting');
  await writePrivateJson(directory, 'columns.json', { chatId: String(demoChat.id) });
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), { chatId: String(demoChat.id) });
  await rm(join(directory, 'config.json'));
  await writeFile(join(directory, 'outside.json'), '{}');
  await symlink(join(directory, 'outside.json'), join(directory, 'config.json'));
  await assert.rejects(loadConfig(directory), { code: 'unavailable' });
});

test('one selected chat loads history and live updates without marking messages as read', async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  assert.equal((await source.listChats(''))[0]!.title, demoChat.title);
  await source.addChat(String(demoChat.id));
  assert.deepEqual(source.snapshot().feeds[`live-${demoChat.id}`]!.map(message => message.id), ['1', '2', '3']);
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(4, '<script>fictional content</script>') });
  assert.equal(source.snapshot().feeds[`live-${demoChat.id}`]!.at(-1)!.text, '<script>fictional content</script>');
  await fake.update({ _: 'updateMessageContent', chat_id: demoChat.id, message_id: 4, new_content: fakeMessage(4, 'Edited fictional content').content });
  assert.equal(source.snapshot().feeds[`live-${demoChat.id}`]!.at(-1)!.text, 'Edited fictional content');
  await fake.update({ _: 'updateDeleteMessages', chat_id: demoChat.id, message_ids: [4], is_permanent: true, from_cache: false });
  assert.equal(source.snapshot().feeds[`live-${demoChat.id}`]!.length, 3);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'columns.json'), 'utf8')), { chatIds: [String(demoChat.id)] });
  assert.ok(!fake.requests.some(request => ['viewMessages', 'openChat', 'sendMessage'].includes(request._)));
});

test('converter excludes secret chats and displays untrusted message text literally', () => {
  assert.equal(convertChat({ ...demoChat, type: { _: 'chatTypeSecret', secret_chat_id: 1, user_id: 2 } }), undefined);
  const wire = convertMessage(fakeMessage(1, '<img src=x onerror=alert(1)>'), convertChat(demoChat)!, 'Synthetic Sender');
  assert.equal(wire.text, '<img src=x onerror=alert(1)>');
  assert.deepEqual(wire.entities, []);
});

test('406 messages are not read, known errors map safely and raw SDK messages never escape', () => {
  const forbidden = { code: 406, get message(): string { throw new Error('Must not read this'); } };
  assert.equal(telegramError(forbidden).code, 'unavailable');
  assert.equal(telegramError({ code: 400, message: 'PHONE_CODE_INVALID' }).code, 'invalidCode');
  assert.equal(telegramError({ code: 400, message: 'PHONE_CODE_EXPIRED' }).code, 'expiredCode');
  assert.equal(telegramError({ code: 400, message: 'PASSWORD_HASH_INVALID' }).code, 'invalidPassword');
  assert.ok(telegramError('raw private text') instanceof OperationError);
});

test('TDLib flood waits set a cooldown, and SDK text never matches prototype keys', () => {
  assert.deepEqual({ ...telegramError({ code: 429, message: 'Too Many Requests: retry after 39' }) }, { name: 'OperationError', code: 'rateLimited', status: 429, retryAfter: 39 });
  assert.equal(telegramError({ code: 429, message: 'Too Many Requests' }).code, 'rateLimited');
  assert.equal(telegramError({ code: 400, message: 'FLOOD_WAIT_999999' }).retryAfter, 86400);
  for (const message of ['constructor', '__proto__', 'toString']) assert.equal(telegramError({ code: 400, message }).code, 'unavailable');
});

test('converter labels media and shows the emoji of emoji messages', () => {
  const content = (value: object) => ({ ...fakeMessage(1), content: value }) as unknown as Td.message;
  const chat = convertChat(demoChat)!;
  assert.equal(convertMessage(content({ _: 'messageDice', emoji: '🎲', value: 3 }), chat, 'Synthetic Sender').text, '🎲');
  assert.equal(convertMessage(content({ _: 'messageAnimatedEmoji', emoji: '🦊' }), chat, 'Synthetic Sender').text, '🦊');
  assert.equal(convertMessage(content({ _: 'messageVenue' }), chat, 'Synthetic Sender').text, 'Venue');
  assert.equal(convertMessage(content({ _: 'messagePinMessage', message_id: 1 }), chat, 'Synthetic Sender').text, 'Service message');
});

test('blank auth input is rejected before it reaches TDLib', async t => {
  const { source, fake } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateWaitPhoneNumber' });
  const count = fake.requests.length;
  await assert.rejects(source.submitAuth({ step: 'phone', value: '   ' }), { code: 'invalidRequest' });
  assert.equal(fake.requests.length, count);
});

test('a failed config write keeps the current client and login step', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateWaitPhoneNumber' });
  await chmod(directory, 0o500);
  try {
    await assert.rejects(source.setup({ apiId: 5678, apiHash: 'b'.repeat(32) }), { code: 'unavailable' });
  } finally { await chmod(directory, 0o700); }
  assert.equal(fake.closed, false);
  assert.equal(source.snapshot().auth.state, 'phone');
  await source.submitAuth({ step: 'phone', value: '+' + '491234567890' });
  assert.equal(fake.requests.at(-1)!._, 'setAuthenticationPhoneNumber');
});

test('updates apply in order while a sender lookup is slow', async t => {
  const { source, fake } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  const events: ServerEvent[] = [];
  source.subscribe(event => events.push(event));
  let release!: () => void;
  fake.hold = new Promise<void>(resolve => { release = resolve; });
  // Message 4 comes from an unknown sender, so its name lookup waits on TDLib.
  // Message 5 comes from a cached sender. The edit and the delete refer to 4.
  const newSender = { ...fakeMessage(4), sender_id: { _: 'messageSenderUser', user_id: 200 } } as Td.message;
  await fake.update({ _: 'updateNewMessage', message: newSender });
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(5) });
  await fake.update({ _: 'updateMessageContent', chat_id: demoChat.id, message_id: 4, new_content: fakeMessage(4, 'Edited fictional content').content });
  release();
  fake.hold = undefined;
  await fake.update({ _: 'updateDeleteMessages', chat_id: demoChat.id, message_ids: [5], is_permanent: true, from_cache: false });
  assert.deepEqual(events.map(event => event.type === 'message' || event.type === 'messageEdited' ? `${event.type}:${event.message.id}` : event.type),
    ['message:4', 'message:5', 'messageEdited:4', 'messagesDeleted']);
  assert.deepEqual(source.snapshot().feeds[`live-${demoChat.id}`]!.map(message => [message.id, message.text]),
    [['1', 'A fictional message'], ['2', 'A fictional message'], ['3', 'A fictional message'], ['4', 'Edited fictional content']]);
});

test('multiple columns add concurrently, receive isolated updates and can be removed independently', async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  await Promise.all([source.addChat(String(demoChat.id)), source.addChat(String(secondChat.id))]);
  const ids = [`live-${demoChat.id}`, `live-${secondChat.id}`];
  assert.deepEqual(source.snapshot().columns.map(column => column.id), ids);
  assert.equal(source.snapshot().feeds[ids[0]!]!.length, 3);
  assert.equal(source.snapshot().feeds[ids[1]!]![0]!.text, 'A different fictional feed.');
  const beforeDuplicate = fake.requests.length;
  await source.addChat(String(demoChat.id));
  assert.equal(fake.requests.length, beforeDuplicate);
  const events: ServerEvent[] = [];
  source.subscribe(event => events.push(event));
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(4, 'New studio note') });
  await fake.update({ _: 'updateMessageContent', chat_id: secondChat.id, message_id: 1, new_content: fakeMessage(1, 'Updated dispatch').content });
  await fake.update({ _: 'updateMessageEdited', chat_id: secondChat.id, message_id: 1, edit_date: 1800000010, reply_markup: { _: 'replyMarkupRemoveKeyboard', is_personal: false } });
  assert.equal(source.snapshot().feeds[ids[0]!]!.at(-1)!.text, 'New studio note');
  assert.equal(source.snapshot().feeds[ids[1]!]![0]!.text, 'Updated dispatch');
  assert.equal(source.snapshot().feeds[ids[1]!]![0]!.edited, true);
  assert.deepEqual(events.map(event => 'columnId' in event ? event.columnId : undefined), [ids[0], ids[1], ids[1]]);
  await fake.update({ _: 'updateDeleteMessages', chat_id: secondChat.id, message_ids: [1], is_permanent: true, from_cache: false });
  assert.equal(source.snapshot().feeds[ids[0]!]!.length, 4);
  assert.equal(source.snapshot().feeds[ids[1]!]!.length, 0);
  await source.removeColumn(ids[0]!);
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(5) });
  assert.deepEqual(source.snapshot().columns.map(column => column.id), [ids[1]]);
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), { chatIds: [String(secondChat.id)] });
  await source.removeColumn(ids[1]!);
  assert.deepEqual(source.snapshot().columns, []);
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), { chatIds: [] });
  assert.ok(!fake.requests.some(request => ['viewMessages', 'openChat', 'sendMessage'].includes(request._)));
});

for (const legacy of [true, false]) {
  test(`saved ${legacy ? 'legacy single' : 'multiple'} columns restore without rewriting the saved layout`, async t => {
    const { source, fake, directory } = await sourceFixture(t);
    await source.setup(credentials);
    const saved = legacy ? { chatId: String(demoChat.id) } : { chatIds: [String(demoChat.id), String(secondChat.id)] };
    await writePrivateJson(directory, 'columns.json', saved);
    await fake.auth({ _: 'authorizationStateReady' });
    await eventually(() => source.snapshot().columns.length === (legacy ? 1 : 2));
    assert.deepEqual(await readPrivateJson(directory, 'columns.json'), saved);
    await source.addChat(String(secondChat.id));
    assert.equal(source.snapshot().columns.length, 2);
    if (legacy) assert.deepEqual(await readPrivateJson(directory, 'columns.json'), { chatIds: [String(demoChat.id), String(secondChat.id)] });
  });
}

test('one unavailable saved chat does not prevent other columns restoring or erase its saved ID', async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  const saved = { chatIds: ['-100099', String(secondChat.id)] };
  await writePrivateJson(directory, 'columns.json', saved);
  const events: ServerEvent[] = [];
  source.subscribe(event => events.push(event));
  await fake.auth({ _: 'authorizationStateReady' });
  await eventually(() => source.snapshot().columns.length === 1);
  assert.equal(source.snapshot().columns[0]!.title, secondChat.title);
  assert.ok(events.some(event => event.type === 'columnError'));
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), saved);
});

test('history loading preserves edits and deletions while existing columns keep updating', async t => {
  const { source, fake } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  fake.histories.set(secondChat.id, [fakeMessage(3, 'Old version', secondChat.id), fakeMessage(2, 'Will be deleted', secondChat.id), fakeMessage(1, 'Keep', secondChat.id)]);
  let release!: () => void;
  fake.holdMethod = 'getChatHistory';
  fake.hold = new Promise(resolve => { release = resolve; });
  const adding = source.addChat(String(secondChat.id));
  await eventually(() => fake.requests.some(request => request._ === 'getChatHistory' && request.chat_id === secondChat.id));
  await fake.update({ _: 'updateMessageContent', chat_id: secondChat.id, message_id: 3, new_content: fakeMessage(3, 'Edited during loading').content });
  await fake.update({ _: 'updateDeleteMessages', chat_id: secondChat.id, message_ids: [2], is_permanent: true, from_cache: false });
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(4, 'Arrived during loading', secondChat.id) });
  await fake.update({ _: 'updateNewMessage', message: fakeMessage(5, 'Existing column still live') });
  assert.equal(source.snapshot().columns.length, 1);
  release();
  fake.hold = undefined;
  await adding;
  assert.deepEqual(source.snapshot().feeds[`live-${secondChat.id}`]!.map(message => [message.id, message.text]),
    [['1', 'Keep'], ['3', 'Edited during loading'], ['4', 'Arrived during loading']]);
  assert.equal(source.snapshot().feeds[`live-${demoChat.id}`]!.at(-1)!.text, 'Existing column still live');
});

test('failed column writes preserve the existing board and saved layout', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { source, fake, directory } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  const before = source.snapshot();
  await chmod(directory, 0o500);
  try {
    await assert.rejects(source.addChat(String(secondChat.id)), { code: 'unavailable' });
    await assert.rejects(source.removeColumn(`live-${demoChat.id}`), { code: 'unavailable' });
  } finally { await chmod(directory, 0o700); }
  assert.deepEqual(source.snapshot(), before);
  assert.deepEqual(await readPrivateJson(directory, 'columns.json'), { chatIds: [String(demoChat.id)] });
});

test('column limits and invalid chat identifiers do not mutate the board', async t => {
  const { source, fake } = await sourceFixture(t);
  await source.setup(credentials);
  await fake.auth({ _: 'authorizationStateReady' });
  for (const value of ['0', '01', '--1', '1.2', '9007199254740993']) await assert.rejects(source.addChat(value), { code: 'invalidRequest' });
  for (let index = 1; index <= 20; index++) {
    const id = -200000 - index;
    fake.chats.set(id, { ...demoChat, id, title: `Synthetic Column ${index}` });
    await source.addChat(String(id));
  }
  await assert.rejects(source.addChat(String(secondChat.id)), { code: 'columnLimit' });
  assert.equal(source.snapshot().columns.length, 20);
  await source.removeColumn(source.snapshot().columns[0]!.id);
  await source.addChat(String(secondChat.id));
  assert.equal(source.snapshot().columns.at(-1)!.title, secondChat.title);
});

test('a client factory completing after shutdown closes its client immediately', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-shutdown-'));
  const fake = new FakeTelegram();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = new TelegramSource(directory, { factory: async () => { enter(); await gate; return fake.client; } });
  t.after(async () => { release(); await source.close(); await rm(directory, { recursive: true, force: true }); });
  await source.start();
  const pending = source.setup(credentials);
  const rejected = assert.rejects(pending);
  await entered;
  await source.close();
  release();
  await rejected;
  assert.equal(fake.closed, true);
  await fake.auth({ _: 'authorizationStateReady' });
  assert.notEqual(source.snapshot().auth.state, 'ready');
});
