import type * as Td from 'tdlib-types';
import { getTdjson } from 'prebuilt-tdlib';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import packageJson from '../package.json' with { type: 'json' };
import { convertChat, convertMessage, messageText } from './convert.ts';
import { OperationError, telegramError } from './errors.ts';
import { loadConfig, readPrivateJson, validSetup, writePrivateJson, type PrivateConfig } from './storage.ts';
import { createLogger } from './log.ts';
import { validateSend, writeAccess } from './sending.ts';
import { arrangeColumns, changeColumn, defaultPreferences, saveLayout, validatePreferences, validateSettings } from './preferences.ts';
import { avatarRef, AvatarCache, type Avatar } from './avatars.ts';
import type { Source } from './source.ts';
import type { ApiError, AuthInput, AuthState, Chat, Column, Connection, Message, SendInput, ServerEvent, SetupInput, Snapshot, WorkspacePreferences } from './protocol.ts';

export interface TelegramClient {
  invoke: Td.Invoke;
  onUpdate(listener: (update: Td.Update) => void): void;
  onError(listener: (error: unknown) => void): void;
  close(): Promise<void>;
}

const MAX_COLUMNS = 20;
type LiveColumn = {
  raw: Td.chat;
  chat: Chat;
  messages: Message[];
  visible: boolean;
  loading?: {
    edits: Map<string, Partial<Pick<Message, 'text' | 'edited'>>>;
    deleted: Set<string>;
  };
};
type SendRequest = { digest: string; promise: Promise<void>; attempted: boolean; settled: boolean };
const columnId = (chatId: string) => `live-${chatId}`;
const validChatId = (value: unknown): value is string => typeof value === 'string'
  && /^-?[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const HISTORY_LIMIT = 50;
const HISTORY_PAGES = 8;
const CHAT_LIST_LIMIT = 50;
const SENDER_CACHE_LIMIT = 500;
const MAX_AUTH_INPUT = 1024;
const UNKNOWN_SENDER = 'Unknown sender';

// The only runtime import of tdl. Tests inject a synthetic client instead.
export async function createNativeClient(): Promise<TelegramClient> {
  // TDLib creates its database and files with the process umask.
  process.umask(0o077);
  // tdl's debug namespaces can otherwise dump requests when DEBUG=* is set.
  // Resolve from tdl so that this disables the same instance tdl loads.
  const debug = createRequire(import.meta.resolve('tdl'))('debug') as { disable(): unknown };
  debug.disable();
  const tdl = await import('tdl');
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 0 });
  const result = tdl.execute({ _: 'setLogStream', log_stream: { _: 'logStreamEmpty' } });
  if (result._ === 'error') throw new OperationError('unavailable', 503);
  const client = tdl.createBareClient();
  return {
    invoke: client.invoke,
    onUpdate: listener => { client.on('update', listener); },
    onError: listener => { client.on('error', listener); },
    close: () => client.close(),
  };
}

export function authState(state: Td.AuthorizationState): AuthState {
  switch (state._) {
    case 'authorizationStateWaitTdlibParameters': return { state: 'starting' };
    case 'authorizationStateWaitPhoneNumber': return { state: 'phone' };
    case 'authorizationStateWaitCode': {
      const type = state.code_info.type._;
      const delivery = type === 'authenticationCodeTypeTelegramMessage' ? 'telegram'
        : type.startsWith('authenticationCodeTypeSms') ? 'sms'
        : ['authenticationCodeTypeCall', 'authenticationCodeTypeMissedCall', 'authenticationCodeTypeFlashCall'].includes(type) ? 'call'
        : 'other';
      return { state: 'code', delivery };
    }
    case 'authorizationStateWaitPassword': return { state: 'password' };
    case 'authorizationStateWaitEmailAddress': return { state: 'email' };
    case 'authorizationStateWaitEmailCode': return { state: 'emailCode' };
    case 'authorizationStateReady': return { state: 'ready' };
    case 'authorizationStateWaitRegistration': return { state: 'unsupported', reason: 'registration' };
    case 'authorizationStateWaitPremiumPurchase': return { state: 'unsupported', reason: 'premium' };
    case 'authorizationStateWaitOtherDeviceConfirmation': return { state: 'unsupported', reason: 'deviceConfirmation' };
    default: return { state: 'closed' };
  }
}

export class TelegramSource implements Source {
  #directory: string;
  #factory: () => Promise<TelegramClient>;
  #client?: TelegramClient;
  #config?: PrivateConfig;
  #auth: AuthState = { state: 'setup' };
  #authError?: ApiError;
  #connection: Connection = 'connecting';
  #listeners = new Set<(event: ServerEvent) => void>();
  #columns = new Map<string, LiveColumn>();
  #chatIds: string[] = [];
  #preferences = defaultPreferences();
  #customized = false;
  #columnChanges: Promise<void> = Promise.resolve();
  #sendRequests = new Map<string, SendRequest>();
  #sendingChats = new Set<string>();
  #settledMessages = new Set<string>();
  // Promises, so that concurrent lookups of one sender share one request.
  #senders = new Map<string, Promise<Message['sender']>>();
  #avatars: AvatarCache;
  #updates: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;
  #retryUntil = 0;
  #now: () => number;
  #log = createLogger();

  constructor(directory: string, options: { factory?: () => Promise<TelegramClient>; now?: () => number } = {}) {
    this.#directory = directory;
    this.#avatars = new AvatarCache(join(directory, 'tdlib', 'files'));
    this.#factory = options.factory ?? createNativeClient;
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.#directory, 'columns.json');
    this.#readPreferences(saved);
    if (saved && typeof saved === 'object') {
      const ids = 'chatIds' in saved ? saved.chatIds : 'chatId' in saved ? [saved.chatId] : [];
      if (!Array.isArray(ids) || ids.length > MAX_COLUMNS || !ids.every(validChatId)) throw new OperationError('unavailable', 503);
      this.#chatIds = [...new Set(ids)];
    }
    this.#config = await loadConfig(this.#directory);
    if (this.#config) await this.#connect();
  }

  #emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  #setAuth(state: AuthState): void {
    this.#auth = state;
    if (state.state !== 'ready') {
      this.#columns.clear();
      this.#senders.clear();
      this.#avatars.clear();
    }
    this.#emit({ type: 'auth', auth: state });
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }

  async #connect(): Promise<void> {
    if (this.#closed) throw new OperationError('invalidState', 409);
    this.#authError = undefined;
    this.#setAuth({ state: 'starting' });
    try {
      const client = await this.#factory();
      if (this.#closed) { await client.close(); throw new OperationError('invalidState', 409); }
      this.#client = client;
      client.onError(() => { this.#log('source_failed'); });
      client.onUpdate(update => {
        if (this.#closed || this.#client !== client) return;
        // Updates depend on their order: an edit or a delete must not
        // overtake the new message it refers to. Handle them one at a time.
        this.#updates = this.#updates
          .then(() => this.#update(update, client))
          .catch(() => { this.#log('source_failed'); });
      });
    } catch {
      if (!this.#closed) this.#setAuth({ state: 'setup' });
      throw new OperationError('unavailable', 503);
    }
  }

  #checkCooldown(): void {
    const seconds = Math.ceil((this.#retryUntil - this.#now()) / 1000);
    if (seconds > 0) throw new OperationError('rateLimited', 429, seconds);
  }

  #failure(error: unknown): OperationError {
    if (error instanceof OperationError) return error;
    const failure = telegramError(error);
    if (failure.retryAfter) this.#retryUntil = this.#now() + failure.retryAfter * 1000;
    return failure;
  }

  async setup(input: SetupInput): Promise<void> {
    if (!validSetup(input)) throw new OperationError('invalidRequest');
    this.#checkCooldown();
    if (this.#busy || this.#auth.state === 'ready' || this.#closed) throw new OperationError('invalidState', 409);
    this.#busy = true;
    try {
      const config = { apiId: input.apiId, apiHash: input.apiHash, databaseKey: this.#config?.databaseKey ?? randomBytes(32).toString('base64') };
      // Save first: if the write fails, the current client and state stay intact.
      await writePrivateJson(this.#directory, 'config.json', config);
      if (this.#closed) throw new OperationError('invalidState', 409);
      this.#config = config;
      const previous = this.#client;
      this.#client = undefined;
      await previous?.close();
      await this.#connect();
    } finally { this.#busy = false; }
  }

  async submitAuth(input: AuthInput): Promise<void> {
    this.#checkCooldown();
    const client = this.#client;
    const changePhone = input.step === 'phone' && ['code', 'password', 'email', 'emailCode', 'unsupported'].includes(this.#auth.state);
    if (!client || this.#busy || (input.step !== this.#auth.state && !changePhone) || this.#closed) throw new OperationError('invalidState', 409);
    if (typeof input.value !== 'string') throw new OperationError('invalidRequest');
    const value = input.step === 'password' ? input.value : input.value.trim();
    if (value.length < 1 || value.length > MAX_AUTH_INPUT) throw new OperationError('invalidRequest');
    this.#busy = true;
    try {
      switch (input.step) {
        case 'phone': {
          const phone = value.replace(/[ ()-]/g, '');
          if (!/^\+\d{8,15}$/.test(phone)) throw new OperationError('invalidPhone');
          await client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: phone });
          break;
        }
        case 'code': await client.invoke({ _: 'checkAuthenticationCode', code: value }); break;
        case 'password': await client.invoke({ _: 'checkAuthenticationPassword', password: value }); break;
        case 'email': await client.invoke({ _: 'setAuthenticationEmailAddress', email_address: value }); break;
        case 'emailCode': await client.invoke({ _: 'checkAuthenticationEmailCode', code: { _: 'emailAddressAuthenticationCode', code: value } }); break;
      }
    } catch (error) { throw this.#failure(error); }
    finally { this.#busy = false; }
  }

  #readyClient(): TelegramClient {
    this.#checkCooldown();
    if (!this.#client || this.#auth.state !== 'ready' || this.#closed) throw new OperationError('invalidState', 409);
    return this.#client;
  }

  async #refreshAccess(column: LiveColumn, client: TelegramClient, onlyLocal = true): Promise<void> {
    const raw = await client.invoke({ _: 'getChat', chat_id: Number(column.chat.id) });
    const access = await writeAccess(raw, client.invoke, onlyLocal);
    column.raw = raw;
    Object.assign(column.chat, { sendRestriction: undefined, replyOnly: undefined }, access);
  }

  /** A request ID is reused after a lost HTTP response, never as an automatic resend. */
  async send(input: SendInput): Promise<void> {
    validateSend(input);
    const digest = createHash('sha256').update(JSON.stringify([input.chatId, input.text, input.replyTo?.messageId])).digest('hex');
    const existing = this.#sendRequests.get(input.requestId);
    if (existing) {
      if (existing.digest !== digest) throw new OperationError('invalidRequest');
      return existing.promise;
    }
    if (this.#sendRequests.size >= 1000) {
      const oldest = [...this.#sendRequests].find(([, request]) => request.settled);
      if (!oldest) throw new OperationError('invalidState', 409);
      this.#sendRequests.delete(oldest[0]);
    }
    const request: SendRequest = { digest, promise: Promise.resolve(), attempted: false, settled: false };
    request.promise = Promise.resolve().then(() => this.#sendOnce(input, request)).catch(error => {
      if (!request.attempted) this.#sendRequests.delete(input.requestId);
      throw this.#failure(error);
    }).finally(() => { request.settled = true; });
    this.#sendRequests.set(input.requestId, request);
    return request.promise;
  }

  async #sendOnce(input: SendInput, request: SendRequest): Promise<void> {
    const client = this.#readyClient();
    const column = this.#columns.get(input.chatId);
    if (!column?.visible) throw new OperationError('invalidState', 409);
    if (this.#sendingChats.has(input.chatId)) throw new OperationError('invalidState', 409);
    this.#sendingChats.add(input.chatId);
    try {
      await this.#refreshAccess(column, client, false);
      this.#emit({ type: 'snapshot', data: this.snapshot() });
      if (!column.chat.canSend) throw new OperationError(column.chat.sendRestriction === 'paid' ? 'paidMessage' : 'sendForbidden', 403);
      if (column.chat.replyOnly && !input.replyTo) throw new OperationError('replyRequired');
      let target: Td.message | undefined;
      if (input.replyTo) {
        try {
          target = await client.invoke({ _: 'getMessage', chat_id: Number(input.chatId), message_id: Number(input.replyTo.messageId) });
          const properties = await client.invoke({ _: 'getMessageProperties', chat_id: Number(input.chatId), message_id: Number(input.replyTo.messageId) });
          if (target.chat_id !== Number(input.chatId) || target.sending_state || !properties.can_be_replied) throw new OperationError('replyUnavailable');
        } catch (error) {
          const failure = this.#failure(error);
          if (failure.code === 'rateLimited') throw failure;
          throw new OperationError('replyUnavailable');
        }
      }
      if (this.#readyClient() !== client || this.#columns.get(input.chatId) !== column) throw new OperationError('invalidState', 409);
      request.attempted = true;
      let message: Td.message;
      try {
        message = await client.invoke({ _: 'sendMessage', chat_id: Number(input.chatId),
          ...(target?.topic_id ? { topic_id: target.topic_id } : {}),
          ...(target ? { reply_to: { _: 'inputMessageReplyToMessage' as const, message_id: target.id } } : {}),
          options: { _: 'messageSendOptions', paid_message_star_count: 0, allow_paid_broadcast: false,
            disable_notification: column.raw.default_disable_notification ?? false },
          input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: input.text, entities: [] },
            clear_draft: false, link_preview_options: { _: 'linkPreviewOptions', is_disabled: true } },
        });
      } catch (error) {
        const failure = this.#failure(error);
        if (failure.code === 'unavailable') throw new OperationError('sendUncertain', 503);
        request.attempted = false;
        throw failure;
      }
      // A terminal update may arrive before the invoke promise resolves.
      if (!this.#settledMessages.has(`${message.chat_id}:${message.id}`)) await this.#receiveMessage(message, client);
    } finally { this.#sendingChats.delete(input.chatId); }
  }

  async #receiveMessage(raw: Td.message, client: TelegramClient, oldId?: number): Promise<void> {
    const column = this.#columns.get(String(raw.chat_id));
    if (!column || this.#client !== client || this.#closed || this.#auth.state !== 'ready') return;
    const sender = await this.#sender(raw, client);
    const message = convertMessage(raw, column.chat, sender.name, sender.avatar);
    if (this.#columns.get(column.chat.id) !== column || this.#client !== client) return;
    const oldKey = oldId === undefined ? undefined : `${raw.chat_id}:${oldId}`;
    if (oldKey) {
      this.#settledMessages.add(oldKey);
      if (this.#settledMessages.size > 2000) this.#settledMessages.delete(this.#settledMessages.values().next().value!);
      column.messages = column.messages.filter(item => item.key !== oldKey);
      if (oldId !== raw.id) column.loading?.deleted.add(String(oldId));
    } else if (this.#settledMessages.has(message.key)) return;
    this.#merge(column, [message]);
    if (column.visible) this.#emit(oldKey
      ? { type: 'messageReplaced', columnId: columnId(column.chat.id), oldKey, message }
      : { type: 'message', columnId: columnId(column.chat.id), message });
  }

  async listChats(query: string): Promise<Chat[]> {
    const client = this.#readyClient();
    try {
      if (!query) {
        // 404 means that TDLib has already loaded the whole main list.
        try { await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: CHAT_LIST_LIMIT }); }
        catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
      }
      const result = query
        ? await client.invoke({ _: 'searchChats', query, limit: CHAT_LIST_LIMIT })
        : await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: CHAT_LIST_LIMIT });
      const chats = await Promise.all(result.chat_ids.slice(0, CHAT_LIST_LIMIT)
        .map(async id => convertChat(await client.invoke({ _: 'getChat', chat_id: id }))));
      return chats.filter(chat => chat !== undefined);
    } catch (error) { throw this.#failure(error); }
  }

  #sender(message: Td.message, client: TelegramClient): Promise<Message['sender']> {
    const sender = message.sender_id;
    const key = sender._ === 'messageSenderUser' ? `u:${sender.user_id}` : `c:${sender.chat_id}`;
    let name = this.#senders.get(key);
    if (!name) {
      if (this.#senders.size >= SENDER_CACHE_LIMIT) this.#senders.clear();
      name = this.#lookupSender(sender, client);
      this.#senders.set(key, name);
    }
    return name;
  }

  async #lookupSender(sender: Td.MessageSender, client: TelegramClient): Promise<Message['sender']> {
    try {
      if (sender._ === 'messageSenderUser') {
        const user = await client.invoke({ _: 'getUser', user_id: sender.user_id });
        return { name: [user.first_name, user.last_name].filter(Boolean).join(' ') || UNKNOWN_SENDER,
          avatar: avatarRef(user.profile_photo?.small) };
      }
      const chat = await client.invoke({ _: 'getChat', chat_id: sender.chat_id });
      return { name: chat.title, avatar: avatarRef(chat.photo?.small) };
    } catch { return { name: UNKNOWN_SENDER }; } // Raw SDK errors are never rendered.
  }

  async avatar(id: string): Promise<Avatar> {
    const client = this.#readyClient();
    if (!this.#preferences.settings.profilePictures) throw new OperationError('notFound', 404);
    const ref = [...this.#columns.values()].filter(column => column.visible).flatMap(column => column.messages)
      .map(message => message.sender.avatar).find(avatar => avatar?.id === id);
    if (!ref) throw new OperationError('notFound', 404);
    const avatar = await this.#avatars.get(ref, client.invoke);
    if (this.#client !== client || this.#closed || !this.#preferences.settings.profilePictures) throw new OperationError('notFound', 404);
    return avatar;
  }

  #merge(column: LiveColumn, messages: Message[]): void {
    const unique = new Map([...column.messages, ...messages].map(message => [message.key, message]));
    // Local pending IDs and server IDs need not share one numeric sequence.
    column.messages = [...unique.values()].sort((a, b) => a.date - b.date || Number(a.id) - Number(b.id)).slice(-HISTORY_LIMIT);
  }

  #changeColumns(action: () => Promise<void>): Promise<void> {
    const task = this.#columnChanges.then(action);
    this.#columnChanges = task.catch(() => {});
    return task;
  }

  #readPreferences(saved: unknown): void {
    if (saved && typeof saved === 'object' && 'workspace' in saved) {
      validatePreferences(saved.workspace);
      this.#preferences = saved.workspace;
      this.#customized = true;
    }
  }

  async #persistBoard(chatIds: string[], preferences = this.#preferences, customized = this.#customized): Promise<void> {
    const next = structuredClone(preferences);
    const ids = chatIds.map(columnId);
    next.columns = [...next.columns.filter(column => ids.includes(column.id)),
      ...ids.filter(id => !next.columns.some(column => column.id === id)).map(id => ({ id, width: 'medium' as const }))];
    await writePrivateJson(this.#directory, 'columns.json', { chatIds, ...(customized ? { workspace: next } : {}) });
    this.#chatIds = chatIds;
    this.#preferences = next;
    this.#customized = customized;
  }

  async updateSettings(value: unknown): Promise<void> {
    validateSettings(value);
    await this.#changeColumns(async () => {
      if (this.#closed) throw new OperationError('invalidState', 409);
      await this.#persistBoard(this.#chatIds, { ...this.#preferences, settings: structuredClone(value) }, true);
      if (!value.profilePictures) this.#avatars.clear();
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async updateColumn(id: string, value: unknown): Promise<void> {
    await this.#changeColumns(async () => {
      this.#readyClient();
      const next = changeColumn(this.#preferences, this.snapshot().columns, id, value);
      await this.#persistBoard(this.#chatIds, next, true);
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async saveLayout(value: unknown): Promise<void> {
    await this.#changeColumns(async () => {
      this.#readyClient();
      await this.#persistBoard(this.#chatIds, saveLayout(this.#preferences, this.snapshot().columns, value), true);
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async deleteLayout(id: string): Promise<void> {
    await this.#changeColumns(async () => {
      this.#readyClient();
      if (!this.#preferences.layouts.some(layout => layout.id === id)) throw new OperationError('notFound', 404);
      await this.#persistBoard(this.#chatIds, { ...this.#preferences, layouts: this.#preferences.layouts.filter(layout => layout.id !== id) }, true);
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async applyLayout(id: string): Promise<void> {
    await this.#changeColumns(async () => {
      const client = this.#readyClient();
      const layout = this.#preferences.layouts.find(layout => layout.id === id);
      if (!layout) throw new OperationError('notFound', 404);
      const chatIds = layout.columns.map(column => column.id.slice(5));
      if (!layout.columns.every(column => column.id.startsWith('live-')) || !chatIds.every(validChatId)) throw new OperationError('invalidRequest');
      const added: string[] = [];
      try {
        for (const chatId of chatIds) if (!this.#columns.has(chatId)) {
          await this.#loadColumn(chatId, client);
          added.push(chatId);
        }
        if (this.#readyClient() !== client) throw new OperationError('invalidState', 409);
        await this.#persistBoard(chatIds, { ...this.#preferences, columns: layout.columns,
          settings: { ...this.#preferences.settings, layout: layout.layout } }, true);
      } catch (error) { for (const chatId of added) this.#columns.delete(chatId); throw this.#failure(error); }
      for (const [chatId, column] of this.#columns) {
        if (chatIds.includes(chatId)) column.visible = true;
        else this.#columns.delete(chatId);
      }
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async addChat(chatId: string): Promise<void> {
    if (!validChatId(chatId)) throw new OperationError('invalidRequest');
    return this.#changeColumns(async () => {
      const client = this.#readyClient();
      if (this.#columns.has(chatId)) return;
      if (!this.#chatIds.includes(chatId) && this.#chatIds.length >= MAX_COLUMNS) throw new OperationError('columnLimit', 409);
      try {
        const column = await this.#loadColumn(chatId, client);
        const chatIds = [...new Set([...this.#chatIds, chatId])];
        await this.#persistBoard(chatIds);
        if (this.#client !== client || this.#auth.state !== 'ready' || this.#closed) throw new OperationError('invalidState', 409);
        this.#chatIds = chatIds;
        column.visible = true;
        this.#emit({ type: 'snapshot', data: this.snapshot() });
      } catch (error) {
        this.#columns.delete(chatId);
        throw this.#failure(error);
      }
    });
  }

  async removeColumn(id: string): Promise<void> {
    return this.#changeColumns(async () => {
      this.#readyClient();
      const chatId = this.#chatIds.find(chatId => columnId(chatId) === id);
      if (!chatId) throw new OperationError('notFound', 404);
      const chatIds = this.#chatIds.filter(value => value !== chatId);
      // Persist before changing the board, so a failed write leaves it intact.
      await this.#persistBoard(chatIds);
      this.#chatIds = chatIds;
      this.#columns.delete(chatId);
      this.#emit({ type: 'snapshot', data: this.snapshot() });
    });
  }

  async #loadColumn(chatId: string, client: TelegramClient): Promise<LiveColumn> {
    try {
      const raw = await client.invoke({ _: 'getChat', chat_id: Number(chatId) });
      const chat = convertChat(raw);
      if (!chat || chat.id !== chatId) throw new OperationError('invalidRequest');
      try { Object.assign(chat, await writeAccess(raw, client.invoke)); }
      catch { chat.sendRestriction = 'unavailable'; }
      const loading: NonNullable<LiveColumn['loading']> = { edits: new Map(), deleted: new Set() };
      const column: LiveColumn = { raw, chat, messages: [], visible: false, loading };
      this.#columns.set(chatId, column);
      // TDLib chooses the page size and often returns only a few local
      // messages first. Page backwards until the history limit is reached.
      const history: Td.message[] = [];
      const seen = new Set<number>();
      let cursor = 0;
      for (let page = 0; page < HISTORY_PAGES && history.length < HISTORY_LIMIT; page++) {
        const batch = await client.invoke({ _: 'getChatHistory', chat_id: Number(chatId), from_message_id: cursor, offset: 0, limit: HISTORY_LIMIT, only_local: false });
        const fresh = batch.messages.filter((message): message is Td.message => message != null && !seen.has(message.id));
        if (!fresh.length) break;
        for (const message of fresh) { history.push(message); seen.add(message.id); }
        cursor = fresh.at(-1)!.id;
      }
      const messages = await Promise.all(history.slice(0, HISTORY_LIMIT)
        .map(async raw => { const sender = await this.#sender(raw, client); return convertMessage(raw, chat, sender.name, sender.avatar); }));
      if (this.#client !== client || this.#auth.state !== 'ready' || this.#closed) throw new OperationError('invalidState', 409);
      // Preserve new messages, edits and deletions received during loading.
      const live = column.messages;
      column.messages = messages;
      this.#merge(column, live);
      column.messages = column.messages.filter(message => !loading.deleted.has(message.id));
      for (const message of column.messages) Object.assign(message, loading.edits.get(message.id));
      column.loading = undefined;
      return column;
    } catch (error) {
      this.#columns.delete(chatId);
      throw this.#failure(error);
    }
  }

  async #restore(): Promise<void> {
    try {
      await this.#changeColumns(async () => {
        const client = this.#readyClient();
        const saved = await readPrivateJson(this.#directory, 'columns.json');
        this.#readPreferences(saved);
        if (saved === undefined) { this.#chatIds = []; return; }
        // Accept the original single-column layout without losing that chat.
        const ids = saved && typeof saved === 'object'
          ? 'chatIds' in saved ? saved.chatIds : 'chatId' in saved ? [saved.chatId] : undefined
          : undefined;
        if (!Array.isArray(ids) || ids.length > MAX_COLUMNS || !ids.every(validChatId)) throw new OperationError('unavailable', 503);
        this.#chatIds = [...new Set(ids)];
        for (const chatId of this.#chatIds) {
          try {
            this.#readyClient();
            const column = await this.#loadColumn(chatId, client);
            column.visible = true;
            this.#emit({ type: 'snapshot', data: this.snapshot() });
          } catch (error) { this.#columnError(columnId(chatId), error); }
        }
      });
    } catch (error) {
      this.#columnError('layout', error);
    }
  }

  #columnError(id: string, error: unknown): void {
    const failure = this.#failure(error);
    this.#emit(failure.code === 'rateLimited'
      ? { type: 'columnError', columnId: id, code: 'rateLimited', ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) }
      : { type: 'columnError', columnId: id, code: 'unavailable' });
  }

  async #initialize(client: TelegramClient): Promise<void> {
    const config = this.#config;
    if (!config) throw new OperationError('invalidState', 409);
    const root = join(this.#directory, 'tdlib');
    const database = join(root, 'database');
    const files = join(root, 'files');
    try {
      for (const path of [root, database, files]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        if ((await lstat(path)).isSymbolicLink()) throw new OperationError('unavailable', 503);
        await chmod(path, 0o700);
      }
      if (this.#client !== client || this.#closed) return;
      await client.invoke({ _: 'setTdlibParameters', api_id: config.apiId, api_hash: config.apiHash,
        database_directory: database, files_directory: files, database_encryption_key: config.databaseKey,
        use_message_database: true, use_chat_info_database: true, use_file_database: true, use_secret_chats: false,
        system_language_code: 'en', device_model: 'tgdeck', system_version: process.platform, application_version: packageJson.version });
    } catch (error) {
      if (this.#client !== client || this.#closed) return;
      const failure = this.#failure(error);
      this.#authError = { error: failure.code, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) };
      this.#setAuth({ state: 'setup' });
    }
  }

  async #update(update: Td.Update, client: TelegramClient): Promise<void> {
    // A queued update can outlive the client that produced it.
    if (this.#closed || this.#client !== client) return;
    if (update._ === 'updateAuthorizationState') {
      const wasReady = this.#auth.state === 'ready';
      this.#setAuth(authState(update.authorization_state));
      if (update.authorization_state._ === 'authorizationStateWaitTdlibParameters') await this.#initialize(client);
      // History loading must not hold up the update queue. Live updates for
      // the chats arrive during the load and are merged into their histories.
      else if (this.#auth.state === 'ready' && !wasReady) void this.#restore();
      return;
    }
    if (update._ === 'updateConnectionState') {
      this.#connection = update.state._ === 'connectionStateReady' ? 'connected'
        : update.state._ === 'connectionStateUpdating' ? 'updating' : 'connecting';
      this.#emit({ type: 'connection', connection: this.#connection });
      return;
    }
    if (update._ === 'updateNewMessage' || update._ === 'updateMessageSendSucceeded' || update._ === 'updateMessageSendFailed') {
      if (update._ === 'updateMessageSendFailed') this.#failure(update.error);
      await this.#receiveMessage(update.message, client, 'old_message_id' in update ? update.old_message_id : undefined);
      return;
    }
    if (update._ === 'updateChatPermissions' || update._ === 'updateChatBlockList'
      || update._ === 'updateSupergroup' || update._ === 'updateBasicGroup' || update._ === 'updateUser') {
      if (update._ === 'updateUser') this.#senders.delete(`u:${update.user.id}`);
      for (const column of this.#columns.values()) {
        const type = column.raw.type;
        const affected = 'chat_id' in update ? String(update.chat_id) === column.chat.id
          : update._ === 'updateSupergroup' ? type._ === 'chatTypeSupergroup' && type.supergroup_id === update.supergroup.id
          : update._ === 'updateBasicGroup' ? type._ === 'chatTypeBasicGroup' && type.basic_group_id === update.basic_group.id
          : update._ === 'updateUser' && type._ === 'chatTypePrivate' && type.user_id === update.user.id;
        if (!affected) continue;
        try { await this.#refreshAccess(column, client); }
        catch { column.chat.canSend = false; column.chat.sendRestriction = 'unavailable'; }
        if (column.visible) this.#emit({ type: 'snapshot', data: this.snapshot() });
      }
      return;
    }
    const chatId = 'chat_id' in update ? String(update.chat_id) : undefined;
    const column = chatId ? this.#columns.get(chatId) : undefined;
    if (!column || this.#auth.state !== 'ready') return;
    const id = columnId(column.chat.id);
    if (update._ === 'updateMessageContent') {
      const messageId = String(update.message_id);
      const text = messageText(update.new_content);
      if (column.loading) column.loading.edits.set(messageId, { ...column.loading.edits.get(messageId), text });
      const message = column.messages.find(item => item.id === messageId);
      if (message) {
        message.text = text;
        if (column.visible) this.#emit({ type: 'messageEdited', columnId: id, message });
      }
    } else if (update._ === 'updateMessageEdited') {
      const messageId = String(update.message_id);
      const edited = update.edit_date > 0;
      if (column.loading) column.loading.edits.set(messageId, { ...column.loading.edits.get(messageId), edited });
      const message = column.messages.find(item => item.id === messageId);
      if (message) {
        message.edited = edited;
        if (column.visible) this.#emit({ type: 'messageEdited', columnId: id, message });
      }
    } else if (update._ === 'updateDeleteMessages' && update.is_permanent) {
      // Non-permanent deletions only remove messages from TDLib's cache.
      for (const messageId of update.message_ids) column.loading?.deleted.add(String(messageId));
      const keys = new Set(update.message_ids.map(messageId => `${column.chat.id}:${messageId}`));
      column.messages = column.messages.filter(message => !keys.has(message.key));
      if (column.visible) this.#emit({ type: 'messagesDeleted', columnId: id, keys: [...keys] });
    } else if (update._ === 'updateChatTitle') {
      column.chat.title = update.title;
      for (const message of column.messages) message.chat.title = update.title;
      if (column.visible) this.#emit({ type: 'snapshot', data: this.snapshot() });
    }
  }

  snapshot(): Snapshot {
    const visible = [...this.#columns.values()].filter(column => column.visible);
    const columns = arrangeColumns(visible.map(({ chat }): Column => ({ id: columnId(chat.id), title: chat.title,
      width: 'medium', filter: { type: 'chat', chatId: chat.id }, chat })), this.#preferences);
    return structuredClone({ mode: 'telegram', connection: this.#connection, auth: this.#auth, ...(this.#authError ? { authError: this.#authError } : {}),
      columns, feeds: Object.fromEntries(visible.map(column => [columnId(column.chat.id), column.messages])),
      settings: this.#preferences.settings, layouts: this.#preferences.layouts });
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
    this.#columns.clear();
    this.#senders.clear();
    this.#avatars.clear();
  }
}
