import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type * as Td from 'tdlib-types';
import type { FileRef } from './protocol.ts';
import { OperationError } from './errors.ts';

export type Avatar = { bytes: Buffer; mimeType: string };
const MAX_BYTES = 256 * 1024;
export function avatarRef(file?: Td.file): FileRef | undefined {
  if (!file || !Number.isSafeInteger(file.id) || file.id <= 0 || file.size < 0 || file.size > MAX_BYTES
    || file.expected_size > MAX_BYTES) return undefined;
  return { id: String(file.id), size: file.size || file.expected_size, mimeType: 'image/jpeg' };
}
export function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

/** Only small, visible avatars are passed here. No caller-supplied path is accepted. */
export class AvatarCache {
  #root: string;
  #cache = new Map<string, Avatar>();
  #pending = new Map<string, Promise<Avatar>>();
  #active = 0;
  #waiting: (() => void)[] = [];
  constructor(root: string) { this.#root = root; }
  clear(): void { this.#cache.clear(); }
  async get(ref: FileRef, invoke: Td.Invoke): Promise<Avatar> {
    const cached = this.#cache.get(ref.id);
    if (cached) { this.#cache.delete(ref.id); this.#cache.set(ref.id, cached); return cached; }
    const pending = this.#pending.get(ref.id);
    if (pending) return pending;
    if (this.#pending.size >= 32) throw new OperationError('unavailable', 503);
    const task = this.#download(ref, invoke).finally(() => this.#pending.delete(ref.id));
    this.#pending.set(ref.id, task);
    return task;
  }
  async #download(ref: FileRef, invoke: Td.Invoke): Promise<Avatar> {
    if (this.#active >= 4) await new Promise<void>(resolve => this.#waiting.push(resolve));
    else this.#active++;
    let downloaded = false;
    try {
      const file = await invoke({ _: 'downloadFile', file_id: Number(ref.id), priority: 1, offset: 0, limit: MAX_BYTES, synchronous: true });
      downloaded = true;
      if (!avatarRef(file) || !file.local.is_downloading_completed) throw new OperationError('notFound', 404);
      const root = await realpath(this.#root);
      const path = await realpath(file.local.path);
      const child = relative(root, path);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new OperationError('notFound', 404);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_BYTES) throw new OperationError('notFound', 404);
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const result = await handle.read(buffer, 0, buffer.length, 0);
        if (result.bytesRead !== stat.size || result.bytesRead > MAX_BYTES) throw new OperationError('notFound', 404);
        bytes = buffer.subarray(0, result.bytesRead);
      } finally { await handle.close(); }
      const mimeType = imageType(bytes);
      if (!mimeType) throw new OperationError('notFound', 404);
      const avatar = { bytes, mimeType };
      if (this.#cache.size >= 128) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(ref.id, avatar);
      return avatar;
    } catch { throw new OperationError('notFound', 404); }
    finally {
      // Keep image bytes in the bounded memory cache, not an accumulating disk cache.
      if (downloaded) await invoke({ _: 'deleteFile', file_id: Number(ref.id) }).catch(() => {});
      const next = this.#waiting.shift();
      if (next) next(); else this.#active--;
    }
  }
}

/** Invented geometric portraits, entirely independent of Telegram or user data. */
export function demoAvatar(id: string): Avatar {
  const index = ['demo-mika', 'demo-juno', 'demo-you', 'demo-orbit', 'demo-field'].indexOf(id);
  if (index < 0) throw new OperationError('notFound', 404);
  const backgrounds = ['#bad8ca', '#e4bfd0', '#b6cde5', '#eac88a', '#c9c3e4'];
  const inks = ['#244a42', '#6e3650', '#274968', '#6b481a', '#4b3b6d'];
  const face = index < 3 ? '<path d="M13 64c0-25 38-25 38 0"/><circle cx="32" cy="26" r="13"/><path d="M19 23c-2-24 33-18 26 5l-7-10-19 5" fill="#253a39"/><circle cx="28" cy="26" r="1.5" fill="#fff"/><circle cx="36" cy="26" r="1.5" fill="#fff"/>'
    : index === 3 ? '<circle cx="32" cy="32" r="12"/><ellipse cx="32" cy="32" rx="26" ry="9" transform="rotate(-30 32 32)" fill="none" stroke="#fff" stroke-width="3"/>'
      : '<path d="M19 16h27v34H19z"/><path d="M25 25h15m-15 8h15m-15 8h10" stroke="#fff" stroke-width="2"/>';
  return { mimeType: 'image/svg+xml', bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${backgrounds[index]}"/><g fill="${inks[index]}">${face}</g></svg>`) };
}
