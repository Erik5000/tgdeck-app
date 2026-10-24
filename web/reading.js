// @ts-check
/** @typedef {{ key: string, offset: number }} ReadingAnchor */

/** Keep a message-relative reading position across reflow, with fractional scroll correction.
 * @param {HTMLElement} feed
 */
export function readingPosition(feed) {
  /** @type {ReadingAnchor | undefined} */
  let anchor;
  let width = feed.clientWidth;
  let height = feed.clientHeight;
  let remainder = 0;
  const resized = () => feed.clientWidth !== width || feed.clientHeight !== height;

  /** @param {Set<string>} [skip] */
  function capture(skip = new Set()) {
    width = feed.clientWidth;
    height = feed.clientHeight;
    const top = feed.getBoundingClientRect().top;
    anchor = undefined;
    for (const child of feed.children) {
      const node = /** @type {HTMLElement} */ (child);
      const key = node.dataset.key;
      if (!key || skip.has(key)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top) { anchor = { key, offset: rect.top - top }; break; }
    }
    return anchor;
  }

  /** @param {ReadingAnchor | undefined} [saved] */
  function restore(saved = anchor) {
    const node = [...feed.children].find(child => /** @type {HTMLElement} */ (child).dataset.key === saved?.key);
    if (node && saved) {
      const shift = node.getBoundingClientRect().top - feed.getBoundingClientRect().top - saved.offset;
      const target = feed.scrollTop + remainder + shift;
      feed.scrollTop = target;
      const rounded = target - feed.scrollTop;
      remainder = Math.abs(rounded) < 1 ? rounded : 0;
    }
    capture();
  }
  return { capture, restore, resized, get anchor() { return anchor; } };
}
