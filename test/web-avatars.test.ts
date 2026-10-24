import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeAvatar, disposeAvatars, resetAvatars } from '../web/avatars.js';

test('trimming an offscreen feed releases its picture observers', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  const retained = new Set<Element>();
  class Observer {
    observe(picture: Element) { retained.add(picture); }
    unobserve(picture: Element) { retained.delete(picture); }
    disconnect() { retained.clear(); }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer });
  t.after(() => {
    resetAvatars();
    if (previous) Object.defineProperty(globalThis, 'IntersectionObserver', previous);
    else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  });
  const feed: HTMLImageElement[] = [];
  for (let index = 0; index < 1000; index++) {
    const picture = { src: '', isConnected: true } as HTMLImageElement;
    observeAvatar(picture, 'demo-picture');
    feed.push(picture);
    if (feed.length > 50) {
      const removed = feed.shift()!;
      disposeAvatars({ querySelectorAll: () => [removed] } as unknown as HTMLElement);
    }
    assert.ok(retained.size <= 50);
  }
  assert.equal(retained.size, 50);
});
