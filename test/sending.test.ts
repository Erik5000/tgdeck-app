import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Td from 'tdlib-types';
import { TelegramSource } from '../src/telegram.ts';
import { validateSend, writeAccess } from '../src/sending.ts';
import { FakeTelegram, demoChat, secondChat } from './telegram-fixture.ts';
import type { SendInput, ServerEvent } from '../src/protocol.ts';

const input = (overrides: Partial<SendInput> = {}): SendInput => ({
  requestId: randomUUID(), chatId: String(demoChat.id), text: 'A synthetic outgoing message', ...overrides,
});
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-send-'));
  const fake = new FakeTelegram();
  const source = new TelegramSource(directory, { factory: async () => fake.client });
  t.after(async () => { await source.close(); await rm(directory, { recursive: true, force: true }); });
  await source.start();
  await source.setup({ apiId: 1234, apiHash: 'a'.repeat(32) });
  await fake.auth({ _: 'authorizationStateReady' });
  await source.addChat(String(demoChat.id));
  const messages = () => source.snapshot().feeds[`live-${demoChat.id}`]!;
  return { source, fake, messages };
}
async function until(predicate: () => boolean) {
  for (let i = 0; !predicate() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Synthetic operation completed');
}

test('send validation rejects ambiguous targets, blank or oversized text and extra fields', () => {
  for (const body of [null, [], {}, input({ text: ' \n ' }), input({ chatId: '01' }), input({ chatId: '1e2' }),
    input({ requestId: 'reuse' }), { ...input(), unexpected: true },
    input({ replyTo: { chatId: String(secondChat.id), messageId: '3' } }),
    input({ replyTo: { chatId: String(demoChat.id), messageId: '-3' } }),
    input({ replyTo: { chatId: String(demoChat.id), messageId: '9007199254740992' } }),
  ]) assert.throws(() => validateSend(body), { code: 'invalidRequest' });
  assert.throws(() => validateSend(input({ text: 'x'.repeat(4097) })), { code: 'textTooLong' });
  assert.doesNotThrow(() => validateSend(input({ text: '🦊'.repeat(2048) })));
});

test('write access checks membership, admin posting rights and paid destinations', async () => {
  const fake = new FakeTelegram();
  const group = fake.groups.get(1)!;
  const access = () => writeAccess(demoChat, fake.client.invoke);
  assert.equal((await access()).canSend, true);
  for (const status of [{ _: 'chatMemberStatusLeft' }, { _: 'chatMemberStatusBanned', banned_until_date: 0 },
    { _: 'chatMemberStatusRestricted', is_member: false, permissions: demoChat.permissions },
    { _: 'chatMemberStatusRestricted', is_member: true, permissions: { can_send_basic_messages: false } },
  ] as Td.ChatMemberStatus[]) {
    group.status = status;
    assert.equal((await access()).canSend, false);
  }
  group.status = { _: 'chatMemberStatusMember', member_until_date: 0 };
  assert.equal((await writeAccess({ ...demoChat, permissions: { ...demoChat.permissions, can_send_basic_messages: false } }, fake.client.invoke)).canSend, false);
  group.paid_message_star_count = 5;
  assert.equal((await access()).sendRestriction, 'paid');
  group.paid_message_star_count = 0;
  group.is_broadcast_group = true;
  assert.equal((await access()).canSend, false);
  group.status = { _: 'chatMemberStatusAdministrator', rights: { can_post_messages: false } } as Td.chatMemberStatusAdministrator;
  assert.equal((await access()).canSend, true);
  group.is_channel = true;
  assert.equal((await access()).canSend, false);
  group.status.rights.can_post_messages = true;
  assert.equal((await access()).canSend, true);
  group.is_direct_messages_group = true;
  assert.equal((await access()).canSend, false);
});

test('private and basic-group permissions fail closed for blocked, paid and inactive chats', async () => {
  const fake = new FakeTelegram();
  const privateChat = { ...demoChat, type: { _: 'chatTypePrivate', user_id: 100 } } as Td.chat;
  assert.equal((await writeAccess(privateChat, fake.client.invoke, false)).canSend, true);
  assert.equal(fake.requests.at(-1)!.only_local, false);
  fake.privateAccess = { _: 'canSendMessageToUserResultUserHasPaidMessages', outgoing_paid_message_star_count: 5 };
  assert.equal((await writeAccess(privateChat, fake.client.invoke)).sendRestriction, 'paid');
  fake.privateAccess = { _: 'canSendMessageToUserResultUserIsDeleted' };
  assert.equal((await writeAccess(privateChat, fake.client.invoke)).canSend, false);
  assert.equal((await writeAccess({ ...privateChat, block_list: { _: 'blockListMain' } }, fake.client.invoke)).canSend, false);
  const basic = { ...demoChat, type: { _: 'chatTypeBasicGroup', basic_group_id: 1 } } as Td.chat;
  assert.equal((await writeAccess(basic, fake.client.invoke)).canSend, true);
  fake.basicGroup.is_active = false;
  assert.equal((await writeAccess(basic, fake.client.invoke)).canSend, false);
  assert.equal((await writeAccess({ ...demoChat, type: { _: 'chatTypeSecret', user_id: 100, secret_chat_id: 1 } }, fake.client.invoke)).canSend, false);
});

test('plain text sends only on an explicit request and targets the selected chat', async t => {
  const { source, fake, messages } = await fixture(t);
  assert.equal(fake.sent.length, 0);
  const text = '  <b>Fictional plain text</b>\n🦊  ';
  await source.send(input({ text }));
  const query = fake.requests.find(query => query._ === 'sendMessage')!;
  assert.equal(query.chat_id, demoChat.id);
  assert.equal(query.reply_to, undefined);
  assert.deepEqual(query.input_message_content, { _: 'inputMessageText',
    text: { _: 'formattedText', text, entities: [] }, clear_draft: false,
    link_preview_options: { _: 'linkPreviewOptions', is_disabled: true },
  });
  assert.deepEqual(query.options, { _: 'messageSendOptions', paid_message_star_count: 0, allow_paid_broadcast: false, disable_notification: false });
  assert.equal(messages().at(-1)!.text, text);
  assert.equal(messages().at(-1)!.delivery, 'pending');
  assert.equal(messages().at(-1)!.sender.name, 'You');
  assert.ok(!fake.requests.some(query => query._ === 'viewMessages'));
});

test('send rechecks permissions and rejects closed columns and read-only channels', async t => {
  const { source, fake } = await fixture(t);
  await source.addChat(String(secondChat.id));
  assert.equal(source.snapshot().columns[1]!.chat!.canSend, false);
  await assert.rejects(source.send(input({ chatId: String(secondChat.id) })), { code: 'sendForbidden' });
  fake.groups.get(1)!.status = { _: 'chatMemberStatusLeft' };
  await assert.rejects(source.send(input()), { code: 'sendForbidden' });
  assert.equal(source.snapshot().columns[0]!.chat!.canSend, false);
  await source.removeColumn(`live-${demoChat.id}`);
  await assert.rejects(source.send(input()), { code: 'invalidState' });
  assert.equal(fake.sent.length, 0);
});

test('permission updates refresh the visible composer capability', async t => {
  const { source, fake } = await fixture(t);
  const group = fake.groups.get(1)!;
  group.status = { _: 'chatMemberStatusLeft' };
  await fake.update({ _: 'updateSupergroup', supergroup: group });
  assert.equal(source.snapshot().columns[0]!.chat!.canSend, false);
  group.status = { _: 'chatMemberStatusMember', member_until_date: 0 };
  await fake.update({ _: 'updateSupergroup', supergroup: group });
  assert.equal(source.snapshot().columns[0]!.chat!.canSend, true);
});

test('replies verify their target and preserve its forum topic', async t => {
  const { source, fake } = await fixture(t);
  fake.groups.get(1)!.is_forum = true;
  fake.history[0]!.topic_id = { _: 'messageTopicForum', forum_topic_id: 42 };
  await assert.rejects(source.send(input()), { code: 'replyRequired' });
  const reply = input({ replyTo: { chatId: String(demoChat.id), messageId: '3' } });
  fake.canReply = false;
  await assert.rejects(source.send(reply), { code: 'replyUnavailable' });
  fake.canReply = true;
  await source.send(reply);
  const query = fake.requests.find(query => query._ === 'sendMessage')!;
  assert.deepEqual(query.reply_to, { _: 'inputMessageReplyToMessage', message_id: 3 });
  assert.deepEqual(query.topic_id, fake.history[0]!.topic_id);
  await assert.rejects(source.send(input({ replyTo: { chatId: String(demoChat.id), messageId: '99' } })), { code: 'replyUnavailable' });
  assert.equal(fake.sent.length, 1);
});

test('duplicate and concurrent requests never invoke send twice for the same request ID', async t => {
  const { source, fake } = await fixture(t);
  let release!: () => void;
  fake.holdMethod = 'sendMessage';
  fake.hold = new Promise(resolve => { release = resolve; });
  const value = input();
  const first = source.send(value);
  await until(() => fake.requests.some(query => query._ === 'sendMessage'));
  const duplicate = source.send(value);
  await assert.rejects(source.send({ ...value, text: 'Different fictional text' }), { code: 'invalidRequest' });
  await assert.rejects(source.send(input()), { code: 'invalidState' });
  release();
  await Promise.all([first, duplicate]);
  await source.send(value);
  assert.equal(fake.sent.length, 1);
});

test('uncertain sends retain their request ID, while definite rejection allows an explicit retry', async t => {
  const { source, fake } = await fixture(t);
  fake.failureMethod = 'sendMessage';
  fake.failure = { code: 500, message: 'Fictional sensitive SDK error' };
  const value = input();
  await assert.rejects(source.send(value), { code: 'sendUncertain' });
  fake.failure = undefined;
  await assert.rejects(source.send(value), { code: 'sendUncertain' });
  assert.equal(fake.requests.filter(query => query._ === 'sendMessage').length, 1);
  const retry = input();
  fake.failure = { code: 400, message: 'CHAT_WRITE_FORBIDDEN' };
  await assert.rejects(source.send(retry), { code: 'sendForbidden' });
  fake.failure = undefined;
  await source.send(retry);
  assert.equal(fake.sent.length, 1);
});

test('flood waits preserve the draft request and prevent another network send', async t => {
  const { source, fake } = await fixture(t);
  fake.failureMethod = 'sendMessage';
  fake.failure = { code: 429, message: 'SLOWMODE_WAIT_20' };
  await assert.rejects(source.send(input()), { code: 'rateLimited', retryAfter: 20 });
  fake.failure = undefined;
  await assert.rejects(source.send(input()), { code: 'rateLimited', retryAfter: 20 });
  assert.equal(fake.requests.filter(query => query._ === 'sendMessage').length, 1);
});

test('delivery succeeds by replacing the temporary message exactly once', async t => {
  const { source, fake, messages } = await fixture(t);
  const events: ServerEvent[] = [];
  source.subscribe(event => events.push(event));
  await source.send(input());
  const pending = fake.sent[0]!;
  const delivered = { ...pending, id: 2000, sending_state: undefined };
  await fake.update({ _: 'updateNewMessage', message: pending });
  await fake.update({ _: 'updateMessageSendSucceeded', message: delivered, old_message_id: pending.id });
  await fake.update({ _: 'updateNewMessage', message: pending });
  assert.deepEqual(messages().filter(message => message.own).map(message => [message.id, message.delivery]), [['2000', undefined]]);
  assert.ok(events.some(event => event.type === 'messageReplaced' && event.oldKey === `${demoChat.id}:${pending.id}`));
  await source.send(input({ text: 'A later fictional message' }));
  assert.equal(messages().at(-1)!.text, 'A later fictional message');
});

test('a terminal update before the send response cannot resurrect a pending message', async t => {
  const { source, fake, messages } = await fixture(t);
  fake.onSend = async pending => {
    await fake.update({ _: 'updateMessageSendSucceeded', message: { ...pending, id: 2000, sending_state: undefined }, old_message_id: pending.id });
  };
  await source.send(input());
  assert.deepEqual(messages().filter(message => message.own).map(message => message.id), ['2000']);
});

test('failed delivery replaces the pending entry and exposes no raw SDK error', async t => {
  const { source, fake, messages } = await fixture(t);
  await source.send(input());
  const pending = fake.sent[0]!;
  const error = { _: 'error', code: 400, message: 'Synthetic private error details' } as Td.error;
  const failed = { ...pending, sending_state: { _: 'messageSendingStateFailed', error, retry_after: 0 } } as Td.message;
  await fake.update({ _: 'updateMessageSendFailed', message: failed, old_message_id: pending.id, error });
  const own = messages().filter(message => message.own);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.delivery, 'failed');
  assert.deepEqual(own[0]!.sendError, { error: 'unavailable' });
  assert.ok(!JSON.stringify(source.snapshot()).includes(error.message));
});
