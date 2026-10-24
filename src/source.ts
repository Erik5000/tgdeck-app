import type { ServerEvent, Snapshot } from './protocol.ts';

// Shared lifecycle; live auth and read capabilities live on TelegramSource.
export interface Source {
  snapshot(): Snapshot;
  subscribe(listener: (event: ServerEvent) => void): () => void;
  close(): void | Promise<void>;
}
