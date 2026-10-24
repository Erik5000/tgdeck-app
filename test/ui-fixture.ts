// Invented UI scenarios only. This source never opens a Telegram client or disk storage.
import { DemoSource } from '../src/demo.ts';
import { defaultSettings } from '../src/preferences.ts';
import type { Message, ServerEvent, Snapshot } from '../src/protocol.ts';

export class UiFixture extends DemoSource {
  #extra = new Map<string, Message[]>();
  #listeners = new Set<(event: ServerEvent) => void>();
  #sequence = 0;
  composer = false;

  constructor() { super({ intervalMs: 0, now: () => Date.parse('2026-10-23T10:00:00Z') }); }

  override snapshot(): Snapshot {
    const snapshot = super.snapshot();
    for (const column of snapshot.columns) {
      const extra = this.#extra.get(column.id) ?? [];
      const feed = snapshot.feeds[column.id] ?? [];
      snapshot.feeds[column.id] = column.filter.type === 'chat' ? [...feed, ...extra].slice(-50) : [...extra].reverse().concat(feed).slice(0, 50);
      if (this.composer && column.filter.type === 'chat') {
        column.chat = { id: 'demo-studio', title: 'Little Comet Studio', type: 'group', canSend: true };
      }
    }
    // Exercise the production composer with synthetic data. Do not capture this variant.
    if (this.composer) snapshot.mode = 'telegram';
    return snapshot;
  }

  override subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    const unsubscribe = super.subscribe(listener);
    return () => { this.#listeners.delete(listener); unsubscribe(); };
  }

  publish(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async reset(): Promise<void> {
    this.#extra.clear();
    this.composer = false;
    this.clearBoard();
    await this.updateSettings({ ...defaultSettings, theme: 'light', messageStyle: 'bubbles' });
    this.loadBoard();
    for (const id of ['demo-inspiration', 'demo-chat', 'demo-search', 'demo-mentions']) {
      await this.updateColumn(id, { beforeId: null });
      await this.updateColumn(id, { width: 'medium' });
    }
  }

  longMessage(): void {
    const id = `demo-long-${++this.#sequence}`;
    const message: Message = {
      id, key: `demo-studio:${id}`, chat: { id: 'demo-studio', title: 'Little Comet Studio', type: 'group', canSend: true },
      sender: { name: 'Workshop planning group' }, date: Date.parse('2025-01-15T09:30:00Z') / 1000,
      text: 'Workshop notes\n\n' + Array.from({ length: 8 }, (_, i) => `${i + 1}. Make space for a careful reading. This invented design update includes a longer paragraph so we can check wrapping, attribution and our place while the window changes size.`).join('\n\n') + '\n\nEnd of workshop notes.',
      edited: false, own: false, entities: [],
    };
    for (const columnId of ['demo-chat', 'demo-search']) {
      const extra = this.#extra.get(columnId) ?? [];
      extra.push(message);
      this.#extra.set(columnId, extra);
      this.publish({ type: 'message', columnId, message });
    }
  }
}
