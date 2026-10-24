// @ts-check
import { apiFetch } from './api.js';

/** @typedef {{ controller: AbortController; observer?: IntersectionObserver; ids: WeakMap<Element,string>; active: number; waiting: Map<HTMLImageElement,string>; urls: Set<string> }} Batch */
/** @returns {Batch} */
const newBatch = () => ({ controller: new AbortController(), ids: new WeakMap(), active: 0, waiting: new Map(), urls: new Set() });
let batch = newBatch();

export function resetAvatars() {
  batch.controller.abort();
  batch.observer?.disconnect();
  batch.waiting.clear();
  for (const url of batch.urls) URL.revokeObjectURL(url);
  batch = newBatch();
}

/** Release offscreen observation and queued work before a message is removed.
 * @param {HTMLElement} card
 */
export function disposeAvatars(card) {
  for (const picture of card.querySelectorAll('img')) {
    batch.observer?.unobserve(picture);
    batch.ids.delete(picture);
    batch.waiting.delete(picture);
    if (batch.urls.delete(picture.src)) URL.revokeObjectURL(picture.src);
  }
}

/** Lazy image requests use the same origin-bound credential as other APIs.
 * @param {HTMLImageElement} picture @param {string} id
 */
export function observeAvatar(picture, id) {
  const current = batch;
  current.ids.set(picture, id);
  current.observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      current.observer?.unobserve(entry.target);
      const fileId = current.ids.get(entry.target);
      if (fileId && entry.target instanceof HTMLImageElement) queue(entry.target, fileId, current);
    }
  }, { rootMargin: '160px' });
  current.observer.observe(picture);
}

/** @param {HTMLImageElement} picture @param {string} id @param {Batch} current */
function queue(picture, id, current) {
  if (current.controller.signal.aborted || !picture.isConnected) return;
  if (current.active >= 4) { current.waiting.set(picture, id); return; }
  current.active++;
  void (async () => {
    try {
      const response = await apiFetch(`/api/avatars/${encodeURIComponent(id)}`, { signal: current.controller.signal });
      if (!response.ok) throw new Error('Picture unavailable.');
      const blob = await response.blob();
      if (blob.size > 256 * 1024 || current.controller.signal.aborted || !picture.isConnected) return;
      const url = URL.createObjectURL(blob);
      current.urls.add(url);
      const release = () => { URL.revokeObjectURL(url); current.urls.delete(url); };
      picture.addEventListener('load', release, { once: true });
      picture.addEventListener('error', () => { release(); picture.remove(); }, { once: true });
      picture.src = url;
    } catch { picture.remove(); }
    finally {
      current.active--;
      while (current.active < 4 && current.waiting.size) {
        const next = current.waiting.entries().next().value;
        if (!next) break;
        current.waiting.delete(next[0]);
        queue(next[0], next[1], current);
      }
    }
  })();
}
