import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingPosition } from '../web/reading.js';

function fixture() {
  let scroll = 240;
  const heights = [200, 200, 200, 200];
  const feed = {
    clientWidth: 580, clientHeight: 300,
    get scrollTop() { return scroll; },
    set scrollTop(value: number) { scroll = Math.max(0, Math.min(heights.reduce((a, b) => a + b, 0) - this.clientHeight, Math.round(value))); },
    getBoundingClientRect: () => ({ top: 100 }),
    children: heights.map((_, index) => ({
      dataset: { key: `invented-${index}` },
      getBoundingClientRect: () => {
        const top = 100 + heights.slice(0, index).reduce((a, b) => a + b, 0) - scroll;
        return { top, bottom: top + heights[index]! };
      },
    })),
  };
  return { feed, heights, position: readingPosition(feed as unknown as HTMLElement) };
}

test('paused reflow keeps the same visible message and offset', () => {
  const { feed, heights, position } = fixture();
  const anchor = position.capture();
  assert.deepEqual(anchor, { key: 'invented-1', offset: -40 });
  heights[0] = 320;
  feed.clientWidth = 380;
  assert.equal(position.resized(), true);
  position.restore();
  assert.equal(feed.scrollTop, 360);
  assert.deepEqual(position.anchor, anchor);
  assert.equal(position.resized(), false);
});

test('a subsequent reader scroll becomes the next resize anchor', () => {
  const { feed, heights, position } = fixture();
  position.capture();
  feed.scrollTop = 410;
  const anchor = position.capture();
  heights[0] = 280;
  feed.clientWidth = 340;
  position.restore();
  assert.deepEqual(position.anchor, anchor);
  assert.equal(feed.scrollTop, 490);
});

test('snapshot replacement and deletion can restore a surviving anchor', () => {
  const old = fixture();
  const anchor = old.position.capture(new Set(['invented-1']));
  const next = fixture();
  next.heights[0] = 240;
  next.position.restore(anchor);
  assert.equal(next.feed.scrollTop, 280);
  assert.equal(next.feed.children[2]!.getBoundingClientRect().top - 100, anchor!.offset);
});

test('subpixel growth does not accumulate reading drift', () => {
  const { feed, heights, position } = fixture();
  const anchor = position.capture();
  for (let i = 0; i < 100; i++) {
    heights[0] = heights[0]! + 0.3;
    position.restore(anchor);
    assert.ok(Math.abs(position.anchor!.offset - anchor!.offset) < 1);
  }
  assert.equal(feed.scrollTop, 270);
});

test('scroll limits and missing anchors remain valid', () => {
  const { feed, position } = fixture();
  position.restore({ key: 'invented-0', offset: 50 });
  assert.equal(feed.scrollTop, 0);
  position.restore({ key: 'removed-message', offset: 0 });
  assert.equal(feed.scrollTop, 0);
  assert.deepEqual(position.anchor, { key: 'invented-0', offset: 0 });
});
