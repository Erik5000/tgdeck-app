// @ts-check
const HIGHLIGHT_MS = 12000;
const MAX_ARRIVALS = 50;

/** Page-local arrival markers, independent of Telegram's read receipts. */
export class ArrivalTracker {
  /** @type {Map<string, number>} */
  deadlines = new Map();

  /** @param {string} key */
  add(key) {
    if (this.deadlines.has(key)) return;
    this.deadlines.set(key, Infinity);
    while (this.deadlines.size > MAX_ARRIVALS) {
      const oldest = this.deadlines.keys().next().value;
      if (oldest !== undefined) this.deadlines.delete(oldest);
    }
  }

  /** Start the countdown only when the incoming card is actually visible.
   * @param {string} key @param {number} [now]
   */
  seen(key, now = performance.now()) {
    if (this.deadlines.get(key) === Infinity) this.deadlines.set(key, now + HIGHLIGHT_MS);
  }

  /** @param {string} key */
  has(key) { return this.deadlines.has(key); }
  get size() { return this.deadlines.size; }

  /** @param {Iterable<string>} keys @param {number} [now] */
  retain(keys, now = performance.now()) {
    const present = new Set(keys);
    for (const [key, deadline] of this.deadlines) {
      if (!present.has(key) || deadline <= now) this.deadlines.delete(key);
    }
  }

  /** An edit or ID replacement is not another arrival.
   * @param {string} oldKey @param {string} key
   */
  replace(oldKey, key) {
    if (oldKey === key || !this.deadlines.has(oldKey)) return;
    const deadline = this.deadlines.get(oldKey);
    this.deadlines.delete(oldKey);
    this.deadlines.set(key, Math.max(deadline ?? Infinity, this.deadlines.get(key) ?? 0));
  }
}
