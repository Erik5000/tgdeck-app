// @ts-check
import { errorText } from './login.js';

/**
 * Header-only pointer dragging, with a keyboard equivalent on the grip.
 * Keep the feed DOM stationary until drop so reading positions and drafts survive.
 * @param {HTMLElement} board
 * @param {{ move: (id: string, beforeId: string | null) => Promise<void>; announce: (text: string) => void }} callbacks
 */
export function initColumnReorder(board, callbacks) {
  /** @type {{ section: HTMLElement; handle: HTMLButtonElement; order: HTMLElement[]; index: number;
   * original: number; pointerId?: number; startX: number; startY: number; x: number; y: number;
   * active: boolean; capture?: HTMLElement } | undefined} */
  let state;
  /** @type {HTMLElement | undefined} */
  let ghost;
  /** @type {HTMLElement | undefined} */
  let marker;
  let frame = 0;
  let saving = false;
  let lastFrame = 0;

  function columns() { return [...board.children].filter((node) => node instanceof HTMLElement).filter(node => node.classList.contains('column')); }
  function refresh() {
    for (const handle of board.querySelectorAll('button.column-drag-handle')) {
      /** @type {HTMLButtonElement} */ (handle).disabled = saving || columns().length < 2;
    }
  }
  function cleanup() {
    if (!state) return;
    const previous = state;
    state = undefined;
    cancelAnimationFrame(frame);
    previous.section.classList.remove('column-dragging');
    previous.handle.setAttribute('aria-pressed', 'false');
    board.classList.remove('reordering');
    ghost?.remove(); marker?.remove();
    ghost = marker = undefined;
    if (previous.pointerId !== undefined && previous.capture?.hasPointerCapture(previous.pointerId)) previous.capture.releasePointerCapture(previous.pointerId);
  }
  function cancel() {
    const active = state?.active;
    cleanup();
    if (active) callbacks.announce('Column move canceled.');
  }
  function start() {
    if (!state) return;
    state.active = true;
    board.classList.add('reordering');
    state.section.classList.add('column-dragging');
    state.handle.setAttribute('aria-pressed', 'true');
    marker = document.createElement('div');
    marker.className = 'column-drop-marker';
    marker.setAttribute('aria-hidden', 'true');
    document.body.append(marker);
    if (state.pointerId !== undefined) {
      ghost = document.createElement('div');
      ghost.className = 'column-drag-preview';
      ghost.textContent = state.section.getAttribute('aria-label');
      ghost.setAttribute('aria-hidden', 'true');
      document.body.append(ghost);
      lastFrame = performance.now();
      frame = requestAnimationFrame(autoScroll);
    }
    callbacks.announce(`Moving ${state.section.getAttribute('aria-label')}. Use arrow keys to choose a position, Enter to drop, or Escape to cancel.`);
    draw();
  }
  function draw() {
    if (!state || !marker) return;
    const { section } = state;
    const others = state.order.filter(item => item !== section);
    const target = others[state.index] ?? others.at(-1);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const bounds = board.getBoundingClientRect();
    const after = state.index === others.length;
    const grid = board.dataset.layout === 'grid';
    const left = Math.max(bounds.left, rect.left);
    const right = Math.min(bounds.right, rect.right);
    const top = Math.max(bounds.top, rect.top);
    const bottom = Math.min(bounds.bottom, rect.bottom);
    const edge = grid ? (after ? rect.bottom : rect.top) : (after ? rect.right : rect.left);
    marker.hidden = right <= left || bottom <= top || (grid ? edge < bounds.top || edge > bounds.bottom : edge < bounds.left || edge > bounds.right);
    Object.assign(marker.style, {
      left: `${grid ? left : edge - 2}px`, top: `${grid ? edge - 2 : top}px`,
      width: `${grid ? right - left : 4}px`, height: `${grid ? 4 : bottom - top}px`,
    });
    if (ghost) Object.assign(ghost.style, { left: `${Math.max(8, Math.min(state.x + 16, innerWidth - ghost.offsetWidth - 8))}px`, top: `${Math.max(8, Math.min(state.y + 16, innerHeight - ghost.offsetHeight - 8))}px` });
  }
  function locate() {
    if (!state) return;
    const { section: moving } = state;
    const others = state.order.filter(section => section !== moving);
    let nearest = Infinity;
    let index = state.index;
    for (const [i, section] of others.entries()) {
      const r = section.getBoundingClientRect();
      // Nearest rectangle works for variable widths and the two-row, column-first grid.
      const dx = Math.max(r.left - state.x, 0, state.x - r.right);
      const dy = Math.max(r.top - state.y, 0, state.y - r.bottom);
      const distance = dx * dx + dy * dy;
      if (distance < nearest) {
        nearest = distance;
        const after = board.dataset.layout === 'grid' ? state.y > r.top + r.height / 2 : state.x > r.left + r.width / 2;
        index = i + Number(after);
      }
    }
    state.index = index;
    draw();
  }
  /** @param {number} now */
  function autoScroll(now) {
    if (!state?.active || state.pointerId === undefined) return;
    const r = board.getBoundingClientRect();
    const elapsed = Math.min(32, now - lastFrame);
    lastFrame = now;
    if (state.y >= r.top && state.y <= r.bottom && state.x >= r.left && state.x <= r.right) {
      const speed = (/** @type {number} */ position, /** @type {number} */ low, /** @type {number} */ high) =>
        position < low + 64 ? -Math.min(1, (low + 64 - position) / 64) : position > high - 64 ? Math.min(1, (position - high + 64) / 64) : 0;
      board.scrollLeft += speed(state.x, r.left, r.right) * elapsed * .8;
      if (board.dataset.layout === 'grid') board.scrollTop += speed(state.y, r.top, r.bottom) * elapsed * .8;
    }
    locate();
    frame = requestAnimationFrame(autoScroll);
  }
  async function drop() {
    if (!state?.active) { cleanup(); return; }
    const { section, index, original, order } = state;
    const id = section.dataset.columnId;
    const beforeId = order.filter(item => item !== section)[index]?.dataset.columnId ?? null;
    cleanup();
    if (!id || index === original) return;
    saving = true;
    refresh();
    try {
      await callbacks.move(id, beforeId);
      callbacks.announce(`Column moved to position ${index + 1} of ${order.length}.`);
    } catch (error) { callbacks.announce(errorText(error)); }
    finally {
      saving = false;
      refresh();
      columns().find(column => column.dataset.columnId === id)?.querySelector('button')?.focus({ preventScroll: true });
    }
  }
  /** @param {HTMLElement} section @param {HTMLButtonElement} handle */
  function prepare(section, handle) {
    if (saving || columns().length < 2) return false;
    cleanup();
    const order = columns();
    const original = order.indexOf(section);
    state = { section, handle, order, index: original, original, startX: 0, startY: 0, x: 0, y: 0, active: false };
    return true;
  }
  board.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    const header = event.target.closest('.column-header');
    const control = event.target.closest('button, a, input, textarea, select');
    if (!(header instanceof HTMLElement) || (control && !control.classList.contains('column-drag-handle'))) return;
    const section = header.closest('.column');
    const handle = header.querySelector('.column-drag-handle');
    if (!(section instanceof HTMLElement) || !(handle instanceof HTMLButtonElement) || !prepare(section, handle) || !state) return;
    state.pointerId = event.pointerId;
    state.startX = state.x = event.clientX;
    state.startY = state.y = event.clientY;
    state.capture = header;
    header.setPointerCapture(event.pointerId);
  });
  board.addEventListener('pointermove', event => {
    if (!state || state.pointerId !== event.pointerId) return;
    state.x = event.clientX; state.y = event.clientY;
    if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY) >= 6) start();
    if (state.active) { event.preventDefault(); locate(); }
  });
  board.addEventListener('pointerup', event => {
    if (!state || state.pointerId !== event.pointerId) return;
    const r = board.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) cancel();
    else void drop();
  });
  board.addEventListener('pointercancel', cancel);
  board.addEventListener('lostpointercapture', () => { if (state?.pointerId !== undefined) cancel(); });
  board.addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.classList.contains('column-drag-handle')) return;
    const handle = event.target;
    const section = handle.closest('.column');
    if (!(section instanceof HTMLElement) || saving) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (state?.active) void drop();
      else if (prepare(section, handle)) start();
    } else if (state?.active && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      state.index = event.key === 'Home' ? 0 : event.key === 'End' ? state.order.length - 1
        : Math.max(0, Math.min(state.order.length - 1, state.index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)));
      const target = state.order.filter(item => item !== section)[state.index] ?? state.order.at(-1);
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      draw();
      callbacks.announce(`Position ${state.index + 1} of ${state.order.length}. Enter to drop, Escape to cancel.`);
    } else if (event.key === 'Tab') cancel();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state) { event.preventDefault(); cancel(); } });
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { cancel, refresh };
}
