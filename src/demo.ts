import type { Chat, Column, Message, ServerEvent, Snapshot } from './protocol.ts';
import type { Source } from './source.ts';
import { arrangeColumns, changeColumn, defaultPreferences, saveLayout, validateSettings } from './preferences.ts';
import { OperationError } from './errors.ts';
import { demoAvatar, type Avatar } from './avatars.ts';

const chats: Chat[] = [
  { id: 'demo-orbit', title: 'Orbit Dispatch', type: 'channel', canSend: false },
  { id: 'demo-studio', title: 'Little Comet Studio', type: 'group', canSend: true },
  { id: 'demo-field', title: 'Field Notes', type: 'channel', canSend: false },
];
const columns: Column[] = [
  { id: 'demo-inspiration', title: 'Inspiration', width: 'medium', filter: { type: 'folder', folderId: 'demo-folder' } },
  { id: 'demo-chat', title: 'Little Comet Studio', width: 'medium', filter: { type: 'chat', chatId: 'demo-studio' } },
  { id: 'demo-search', title: 'Design radar', width: 'medium', filter: { type: 'search', keywords: ['design'] } },
  { id: 'demo-mentions', title: 'For you', width: 'medium', filter: { type: 'mentions' } },
];
const seeds = [
  { chat: 0, sender: 'Orbit Dispatch', text: 'A small collection of things worth slowing down for. Today: thoughtful tools, quiet interfaces, and a little space to think.' },
  { chat: 2, sender: 'Field Notes', text: 'Design note 014\n\nThe best workspace gives each idea a little room. Fewer tabs. More perspective.' },
  { chat: 1, sender: 'Mika', text: 'Morning, crew. The new color studies are ready for a look ☀️' },
  { chat: 1, sender: 'You', text: 'Love the softer green. Let’s try that with the warm background.', own: true },
  { chat: 1, sender: 'Juno', text: 'A tiny design detail: the spacing feels much calmer now.' },
  { chat: 0, sender: 'Orbit Dispatch', text: 'Something to try this week: keep one place for the conversations you care about, and let everything else wait.' },
  { chat: 1, sender: 'Mika', text: '@you — which direction should we explore for the next design study?', mentioned: true },
  { chat: 2, sender: 'Field Notes', text: 'A good reminder from today’s sketchbook: leave enough room for the unexpected. ✳' },
];
const liveText = [
  'Fresh from the sketchbook: a design can feel lively without being loud.',
  'Small update: the next studio session is all about making space for better conversations.',
  '@you — a new design idea just landed. What do you think?',
  'A little progress, one thoughtful detail at a time. That’s the note for today.',
];

export class DemoSource implements Source {
  #listeners = new Set<(event: ServerEvent) => void>();
  #messages: Message[] = [];
  #loaded = false;
  #sequence = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #now: () => number;
  #preferences = defaultPreferences();
  #activeIds = columns.map(column => column.id);

  constructor(options: { intervalMs?: number; now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    const interval = options.intervalMs ?? 9000;
    if (interval > 0) {
      this.#timer = setInterval(() => this.tick(), interval);
      this.#timer.unref();
    }
  }

  #message(chatIndex: number, sender: string, text: string, date: number, own = false, mentioned = false): Message {
    const chat = chats[chatIndex]!;
    const id = `demo-${++this.#sequence}`;
    const avatar = sender === 'Mika' ? 'demo-mika' : sender === 'Juno' ? 'demo-juno' : sender === 'You' ? 'demo-you' : chatIndex === 0 ? 'demo-orbit' : 'demo-field';
    return { key: `${chat.id}:${id}`, id, chat, sender: { name: sender, avatar: { id: avatar, mimeType: 'image/svg+xml', size: 1024 } }, text, date, edited: false, own, mentioned, entities: [] };
  }

  #matches(column: Column, message: Message): boolean {
    const filter = column.filter;
    switch (filter.type) {
      case 'chat': return message.chat.id === filter.chatId;
      case 'folder': return message.chat.type === 'channel';
      case 'search': return filter.keywords.some(word => message.text.toLowerCase().includes(word.toLowerCase()));
      case 'mentions': return message.mentioned === true;
    }
  }

  loadBoard(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#messages = seeds.map((seed, index) => this.#message(seed.chat, seed.sender, seed.text,
      Math.floor(this.#now() / 1000) - (seeds.length - index) * 180, seed.own, seed.mentioned));
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }

  clearBoard(): void {
    this.#loaded = false;
    this.#messages = [];
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }

  tick(): void {
    if (!this.#loaded) return;
    const index = this.#sequence % liveText.length;
    const chatIndex = index % chats.length;
    const text = liveText[index]!;
    const message = this.#message(chatIndex, chatIndex === 1 ? 'Juno' : chats[chatIndex]!.title,
      text, Math.floor(this.#now() / 1000), false, text.startsWith('@you'));
    this.#messages.push(message);
    // Bound each feed independently so quieter columns retain their history.
    const retained = new Set(columns.flatMap(column => this.#messages.filter(item => this.#matches(column, item)).slice(-50).map(item => item.key)));
    this.#messages = this.#messages.filter(item => retained.has(item.key));
    for (const column of columns) if (this.#matches(column, message)) {
      this.#emit({ type: 'message', columnId: column.id, message: structuredClone(message) });
    }
  }

  snapshot(): Snapshot {
    const active = this.#loaded ? arrangeColumns(columns.filter(column => this.#activeIds.includes(column.id)), this.#preferences) : [];
    const feeds = Object.fromEntries(active.map(column => {
      const messages = this.#messages.filter(message => this.#matches(column, message)).slice(-50);
      return [column.id, column.filter.type === 'chat' ? messages : messages.reverse()];
    }));
    return structuredClone({ mode: 'demo', connection: 'connected', columns: active, feeds, auth: { state: 'ready' },
      settings: this.#preferences.settings, layouts: this.#preferences.layouts });
  }

  async updateSettings(value: unknown): Promise<void> {
    validateSettings(value);
    this.#preferences.settings = structuredClone(value);
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }
  async avatar(id: string): Promise<Avatar> {
    if (!this.#loaded || !this.#preferences.settings.profilePictures) throw new OperationError('notFound', 404);
    return demoAvatar(id);
  }
  async updateColumn(id: string, value: unknown): Promise<void> {
    this.#preferences = changeColumn(this.#preferences, this.snapshot().columns, id, value);
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }
  async saveLayout(value: unknown): Promise<void> {
    this.#preferences = saveLayout(this.#preferences, this.snapshot().columns, value);
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }
  async deleteLayout(id: string): Promise<void> {
    if (!this.#preferences.layouts.some(layout => layout.id === id)) throw new OperationError('notFound', 404);
    this.#preferences.layouts = this.#preferences.layouts.filter(layout => layout.id !== id);
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }
  async applyLayout(id: string): Promise<void> {
    const layout = this.#preferences.layouts.find(layout => layout.id === id);
    if (!layout || !layout.columns.every(saved => columns.some(column => column.id === saved.id))) throw new OperationError('notFound', 404);
    this.#activeIds = layout.columns.map(column => column.id);
    this.#preferences.columns = structuredClone(layout.columns);
    this.#preferences.settings.layout = layout.layout;
    this.loadBoard();
    this.#emit({ type: 'snapshot', data: this.snapshot() });
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  close(): void {
    clearInterval(this.#timer);
    this.#listeners.clear();
  }
}
