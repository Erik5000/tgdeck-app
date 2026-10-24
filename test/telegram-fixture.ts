import type * as Td from 'tdlib-types';
import type { TelegramClient } from '../src/telegram.ts';

type Query = { _: Td.$FunctionName; [key: string]: unknown };
export const demoChat = {
  _: 'chat', id: -100001, title: 'Synthetic Studio', type: { _: 'chatTypeSupergroup', is_channel: false, supergroup_id: 1 },
  permissions: { _: 'chatPermissions', can_send_basic_messages: true }, default_disable_notification: false,
} as Td.chat;
export const secondChat = { ...demoChat, id: -100002, title: 'Synthetic Dispatch',
  type: { _: 'chatTypeSupergroup', is_channel: true, supergroup_id: 2 } } as Td.chat;
export function fakeMessage(id: number, text = 'A fictional message', chatId = demoChat.id): Td.message {
  return { _: 'message', id, chat_id: chatId, sender_id: { _: 'messageSenderUser', user_id: 100 },
    is_outgoing: false, date: 1800000000 + id, edit_date: 0, contains_unread_mention: false,
    content: { _: 'messageText', text: { _: 'formattedText', text, entities: [] } },
  } as unknown as Td.message; // Synthetic subset: only fields consumed by the app.
}

export class FakeTelegram {
  requests: Query[] = [];
  failure?: unknown;
  failureMethod?: Td.$FunctionName;
  hold?: Promise<void>;
  holdMethod?: Td.$FunctionName;
  closed = false;
  history = [fakeMessage(3), fakeMessage(2), fakeMessage(1)];
  chats = new Map([[demoChat.id, demoChat], [secondChat.id, secondChat]]);
  histories = new Map([[secondChat.id, [fakeMessage(1, 'A different fictional feed.', secondChat.id)]]]);
  groups = new Map<number, Td.supergroup>([1, 2].map(id => [id, {
    _: 'supergroup', id, is_channel: id === 2, status: { _: 'chatMemberStatusMember' },
    is_forum: false, is_broadcast_group: false, is_direct_messages_group: false, paid_message_star_count: 0,
  } as Td.supergroup]));
  basicGroup = { _: 'basicGroup', is_active: true, status: { _: 'chatMemberStatusMember' } } as Td.basicGroup;
  privateAccess: Td.CanSendMessageToUserResult = { _: 'canSendMessageToUserResultOk' };
  canReply = true;
  sent: Td.message[] = [];
  // Synthetic previews may deliver a final update before sendMessage resolves.
  onSend?: (message: Td.message) => Promise<void>;
  #updates = new Set<(update: Td.Update) => void>();
  #errors = new Set<(error: unknown) => void>();

  client: TelegramClient = {
    invoke: (async (query: Query) => {
      this.requests.push(query);
      if (this.hold && (!this.holdMethod || this.holdMethod === query._)) await this.hold;
      if (this.failure && (!this.failureMethod || this.failureMethod === query._)) throw this.failure;
      switch (query._) {
        case 'getChat': {
          const chat = this.chats.get(Number(query.chat_id));
          if (!chat) throw { code: 404, message: 'Synthetic missing chat' };
          return chat;
        }
        case 'getUser': return { _: 'user', first_name: 'Synthetic', last_name: 'Sender' };
        case 'getSupergroup': return this.groups.get(Number(query.supergroup_id));
        case 'getBasicGroup': return this.basicGroup;
        case 'canSendMessageToUser': return this.privateAccess;
        case 'getMessageProperties': return { _: 'messageProperties', can_be_replied: this.canReply };
        case 'getMessage': {
          const history = this.histories.get(Number(query.chat_id)) ?? this.history;
          const message = [...this.sent, ...history].find(message => message.chat_id === query.chat_id && message.id === query.message_id);
          if (!message) throw { code: 400, message: 'MESSAGE_ID_INVALID' };
          return message;
        }
        case 'sendMessage': {
          const content = query.input_message_content as Td.inputMessageText$Input;
          const reply = query.reply_to as Td.inputMessageReplyToMessage$Input | undefined;
          const message = { ...fakeMessage(1000 + this.sent.length, content.text!.text, Number(query.chat_id)),
            is_outgoing: true, sending_state: { _: 'messageSendingStatePending' },
            ...(reply ? { reply_to: { _: 'messageReplyToMessage', chat_id: Number(query.chat_id), message_id: reply.message_id } } : {}),
          } as Td.message;
          this.sent.push(message);
          await this.onSend?.(message);
          return message;
        }
        case 'getChats': case 'searchChats': return { _: 'chats', chat_ids: [...this.chats.values()]
          .filter(chat => !query.query || chat.title.toLowerCase().includes(String(query.query).toLowerCase())).map(chat => chat.id) };
        case 'getChatHistory': {
          const history = this.histories.get(Number(query.chat_id)) ?? (query.chat_id === demoChat.id ? this.history : []);
          return { _: 'messages', messages: query.from_message_id === 0 ? history : [], total_count: history.length };
        }
        default: return { _: 'ok' };
      }
    }) as Td.Invoke,
    onUpdate: listener => { this.#updates.add(listener); },
    onError: listener => { this.#errors.add(listener); },
    close: async () => { this.closed = true; this.#updates.clear(); this.#errors.clear(); },
  };

  // Delivers an update, then waits until the source has handled it.
  async update(update: Td.Update): Promise<void> {
    for (const listener of this.#updates) listener(update);
    await new Promise(resolve => setImmediate(resolve));
  }
  auth(state: Td.AuthorizationState): Promise<void> { return this.update({ _: 'updateAuthorizationState', authorization_state: state }); }
  error(error: unknown): void { for (const listener of this.#errors) listener(error); }
}
