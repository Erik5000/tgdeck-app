// @ts-check
import { apiFetch, initializeSession, clearSession, readEvents, onUnauthorized } from './api.js';
import { resetAvatars, disposeAvatars } from './avatars.js';
/** @import { Column, Message, Mode, Snapshot, ServerEvent } from '../src/protocol.ts' */
import { renderMessage } from './render.js';
import { errorText, initLogin } from './login.js';
import { createComposer } from './composer.js';
import { initPreferences } from './preferences.js';
import { ArrivalTracker } from './arrivals.js';
import { initColumnReorder } from './reorder.js';
import { readingPosition } from './reading.js';

/**
 * @typedef {{
 *   column: Column, section: HTMLElement, feed: HTMLElement,
 *   link: HTMLButtonElement, badge: HTMLElement, activity: HTMLButtonElement, subtitle: HTMLElement, arrivals: ArrivalTracker,
 *   messages: Message[], nodes: Map<string, HTMLElement>, pending: number, position: ReturnType<typeof readingPosition>,
 * }} ColumnView
 * @typedef {{ followNewest: boolean, anchorKey?: string, anchorOffset: number, pending: number }} ScrollState
 */

const MAX_MESSAGES = 50;
const EDGE_PX = 40;
const NOTICE_MS = 5000;
const RECONNECT_MS = 5000;

/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing workspace element.');
  return value;
}
initializeSession();
const board = element('board');
const empty = element('empty');
const nav = element('column-nav');
const notice = element('notice');
const pause = element('pause');
const add = element('add');
/** @type {Map<string, ColumnView>} */
const views = new Map();
// Header, composer and layout changes can resize a feed after its messages render.
const feedSizes = new ResizeObserver(followLatest);
/** @type {Map<string, ReturnType<typeof createComposer>>} */
const composers = new Map();
/** @type {AbortController | undefined} */
let events;
let paused = false;
let busy = false;
let noticeTimer = 0;
let reconnectTimer = 0;
/** @type {Snapshot | undefined} */
let latest;
const preferences = initPreferences({ notify, change: async (path, method, body) => {
  const response = await apiFetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw await response.json();
  renderSnapshot(await response.json());
} });
element('display-settings').addEventListener('click', () => preferences.open());
element('easy-reading').addEventListener('click', () => { void preferences.easyReading(); });
const login = initLogin({ onSnapshot: renderSnapshot, notify, onColumnAdded: chatId => {
  const view = [...views.values()].find(view => view.column.filter.type === 'chat' && view.column.filter.chatId === chatId);
  view?.section.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
  view?.feed.focus({ preventScroll: true });
} });
const reordering = initColumnReorder(board, { announce: notify, move: async (id, beforeId) => {
  const view = views.get(id);
  if (!view) return;
  try {
    const response = await apiFetch(`/api/columns/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beforeId }),
    });
    if (!response.ok) throw await response.json();
    renderSnapshot(await response.json());
  } finally {
    const moved = views.get(id);
    moved?.section.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
} });

/** @param {string} text */
function notify(text) {
  notice.textContent = text;
  notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, NOTICE_MS);
}

/** @param {string} text @param {boolean} online */
function connection(text, online) {
  element('connection').textContent = text;
  element('connection-dot').classList.toggle('online', online);
  element('connection-dot').title = text;
}

function showConnection() {
  if (paused) return connection('Paused · read at your pace', false);
  if (!latest || latest.mode === 'demo') return connection('Demo is live · following latest', true);
  if (latest.auth.state === 'setup') return connection('Local server ready', true);
  const status = { connected: 'Telegram connected · following latest', connecting: 'Connecting to Telegram…', updating: 'Syncing Telegram…' }[latest.connection];
  connection(status, latest.connection === 'connected');
}

/** @param {ColumnView} view */
function isChatView(view) {
  return view.column.filter.type === 'chat';
}

/** Chat columns put the newest message at the bottom; feeds put it at the top. @param {ColumnView} view */
function atNewestEdge(view) {
  const { feed } = view;
  return isChatView(view) ? feed.scrollHeight - feed.scrollTop - feed.clientHeight < EDGE_PX : feed.scrollTop < EDGE_PX;
}

/** @param {ColumnView} view */
function scrollToNewest(view) {
  view.feed.scrollTop = isChatView(view) ? view.feed.scrollHeight : 0;
  view.position.capture();
}

/** @param {ColumnView} view */
function clearPending(view) {
  view.pending = 0;
  showPending(view);
}

/** @param {ColumnView} view */
function showPending(view) {
  const count = view.pending > 99 ? '99+' : String(view.pending);
  view.badge.textContent = count;
  view.badge.hidden = view.pending === 0;
  view.link.setAttribute('aria-label', `Jump to ${view.column.title}${view.pending ? `, ${count} new messages` : ''}`);
  view.link.title = `${view.column.title}${view.pending ? ` · ${count} new messages` : ''}`;
  showActivity(view);
}

/** @param {ColumnView} view */
function showActivity(view) {
  const active = view.pending > 0 || view.arrivals.size > 0;
  view.activity.hidden = !active;
  view.subtitle.classList.toggle('activity-placeholder', active);
  view.activity.textContent = view.pending ? `${view.pending > 99 ? '99+' : view.pending} new ${view.pending === 1 ? 'message' : 'messages'}`
    : view.arrivals.size === 1 ? 'New message' : 'New messages';
  view.activity.setAttribute('aria-label', `New messages in ${view.column.title}; jump to latest`);
  view.section.classList.toggle('has-new-messages', active);
}

/** @param {ColumnView} view */
function updateArrivals(view) {
  view.arrivals.retain(view.nodes.keys());
  const visible = isColumnVisible(view);
  const bounds = visible ? view.feed.getBoundingClientRect() : undefined;
  for (const [key, node] of view.nodes) {
    node.classList.toggle('long-message', node.clientHeight > view.feed.clientHeight);
    const fresh = view.arrivals.has(key);
    if (fresh && bounds) {
      const card = node.getBoundingClientRect();
      if (card.bottom > bounds.top + 24 && card.top < bounds.bottom - 24) view.arrivals.seen(key);
    }
    node.classList.toggle('new-arrival', fresh);
    const label = node.querySelector('.message-new-label');
    if (label instanceof HTMLElement) label.hidden = !fresh;
  }
  showActivity(view);
}

/** A mostly hidden column has not been seen just because its feed is at the newest edge.
 * @param {ColumnView} view
 */
function isColumnVisible(view) {
  if (document.querySelector('dialog[open]') || !element('chat-picker').hidden) return false;
  const feed = view.feed.getBoundingClientRect();
  const viewport = board.getBoundingClientRect();
  const width = Math.max(0, Math.min(feed.right, viewport.right) - Math.max(feed.left, viewport.left));
  const height = Math.max(0, Math.min(feed.bottom, viewport.bottom) - Math.max(feed.top, viewport.top));
  return document.visibilityState === 'visible' && width >= feed.width * .6 && height >= Math.min(120, feed.height);
}

function acknowledgeVisibleColumns() {
  for (const view of views.values()) {
    if (isColumnVisible(view) && atNewestEdge(view)) clearPending(view);
    updateArrivals(view);
  }
}

function followLatest() {
  for (const view of views.values()) {
    if (!paused) scrollToNewest(view);
    else if (view.position.resized()) view.position.restore();
  }
  acknowledgeVisibleColumns();
}

/**
 * The first message that is at least partly visible, with its distance from
 * the top of the feed. Messages in `skip` are about to be removed.
 * @param {ColumnView} view @param {Set<string>} [skip]
 */
function visibleAnchor(view, skip = new Set()) {
  if (view.position.resized()) view.position.restore();
  return view.position.capture(skip);
}

/** @param {ColumnView} view @param {string} key @param {number} offset */
function restoreAnchor(view, key, offset) {
  view.position.restore({ key, offset });
}

/**
 * Live columns always follow new messages. Pause to read preserves the visible
 * anchor instead. The feed disables browser scroll anchoring (overflow-anchor),
 * so this is the only scroll correction.
 * @param {ColumnView} view @param {() => void} change @param {Set<string>} [removed]
 * @returns {boolean} true if the reader follows the newest messages
 */
function changeFeed(view, change, removed) {
  const followNewest = !paused;
  const anchor = followNewest ? undefined : visibleAnchor(view, removed);
  change();
  if (followNewest) scrollToNewest(view);
  else if (anchor) restoreAnchor(view, anchor.key, anchor.offset);
  return followNewest;
}

/** @param {ColumnView} view @param {Message} message */
function addMessage(view, message) {
  if (view.nodes.has(message.key)) { editMessage(view, message); return; }
  if (!message.own) view.arrivals.add(message.key);
  const chat = isChatView(view);
  const followNewest = changeFeed(view, () => {
    const node = messageNode(view, message);
    view.nodes.set(message.key, node);
    if (chat) { view.messages.push(message); view.feed.append(node); }
    else { view.messages.unshift(message); view.feed.prepend(node); }
    while (view.messages.length > MAX_MESSAGES) {
      const oldest = chat ? view.messages.shift() : view.messages.pop();
      if (!oldest) break;
      removeCard(view.nodes.get(oldest.key));
      view.nodes.delete(oldest.key);
    }
  });
  if (followNewest && isColumnVisible(view)) clearPending(view);
  else if (!message.own) {
    view.pending++;
    showPending(view);
  }
  updateArrivals(view);
}

/** @param {ColumnView} view @param {Message} message @param {string} [oldKey] */
function editMessage(view, message, oldKey = message.key) {
  const old = view.nodes.get(oldKey);
  if (!old) return;
  changeFeed(view, () => {
    view.arrivals.replace(oldKey, message.key);
    const node = messageNode(view, message);
    if (oldKey !== message.key) removeCard(view.nodes.get(message.key));
    disposeAvatars(old);
    old.replaceWith(node);
    view.nodes.delete(oldKey);
    view.nodes.set(message.key, node);
    view.messages = view.messages.filter(item => oldKey === message.key || item.key !== message.key)
      .map(item => item.key === oldKey ? message : item);
  }, oldKey === message.key ? undefined : new Set([oldKey]));
  updateArrivals(view);
}

/** @param {ColumnView} view @param {Message} message */
function messageNode(view, message) {
  const composer = composers.get(view.column.id);
  const appearance = { profilePictures: latest?.settings?.profilePictures, newMessage: view.arrivals.has(message.key) };
  return renderMessage(message, isChatView(view), composer && view.column.chat?.canSend
    ? { reply: value => composer.replyTo(value), restore: value => composer.restore(value), ...appearance }
    : appearance);
}

/** @param {ColumnView} view @param {string[]} keys */
function deleteMessages(view, keys) {
  const removed = new Set(keys.filter(key => view.nodes.has(key)));
  if (!removed.size) return;
  changeFeed(view, () => {
    for (const key of removed) {
      removeCard(view.nodes.get(key));
      view.nodes.delete(key);
    }
    view.messages = view.messages.filter(message => !removed.has(message.key));
  }, removed);
  updateArrivals(view);
}

/** @param {Column} column @param {Message[]} messages @param {Mode} mode @param {ArrivalTracker} arrivals @returns {ColumnView} */
function createColumn(column, messages, mode, arrivals) {
  const isChat = column.filter.type === 'chat';
  const section = document.createElement('section');
  section.classList.add('column');
  section.dataset.columnId = column.id;
  section.classList.add(`width-${column.width}`);
  if (isChat) section.classList.add('chat-column');
  section.setAttribute('aria-label', column.title);
  const header = document.createElement('header');
  header.className = 'column-header';
  const icon = document.createElement('button');
  icon.type = 'button';
  icon.className = `column-icon column-drag-handle icon-${column.filter.type}`;
  const glyph = { chat: '↗', folder: '▤', search: '#', mentions: '@' }[column.filter.type];
  icon.textContent = '⠿';
  icon.setAttribute('aria-label', `Move ${column.title} column`);
  icon.setAttribute('aria-pressed', 'false');
  icon.title = 'Drag to rearrange · Space or Enter, then arrow keys to move';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'column-title';
  const title = document.createElement('h2');
  title.textContent = column.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'column-subtitle';
  const sourceLabel = column.chat?.canSend === false ? 'Read only'
    : { chat: 'Conversation', folder: 'Channels', search: 'Keyword · design', mentions: 'Mentions & replies' }[column.filter.type];
  subtitle.textContent = `${sourceLabel} · latest ${isChat ? '↓' : '↑'}`;
  const activity = document.createElement('button');
  activity.className = 'column-activity';
  activity.type = 'button';
  activity.hidden = true;
  titleWrap.append(title, subtitle, activity);
  header.append(icon, titleWrap);
  const options = document.createElement('button');
  options.type = 'button';
  options.className = 'column-options';
  options.textContent = '⋯';
  options.setAttribute('aria-label', `Options for ${column.title}`);
  options.addEventListener('click', () => preferences.openColumn(column));
  header.append(options);
  if (mode === 'telegram') {
    const remove = document.createElement('button');
    remove.className = 'remove-column';
    remove.textContent = '×';
    remove.title = 'Remove column from board';
    remove.setAttribute('aria-label', `Remove ${column.title} column`);
    remove.addEventListener('click', async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      try {
        const response = await apiFetch(`/api/columns/${encodeURIComponent(column.id)}`, { method: 'DELETE' });
        if (!response.ok) throw await response.json();
        renderSnapshot(await response.json());
        element('choose-chat').focus();
      } catch (failure) { notify(errorText(failure)); }
      finally { remove.disabled = false; }
    });
    header.append(remove);
  }
  const feed = document.createElement('div');
  feed.className = 'feed';
  feed.tabIndex = 0;
  feed.setAttribute('aria-label', `${column.title} messages`);
  const link = document.createElement('button');
  link.className = 'rail-button column-link';
  link.append(document.createTextNode(glyph));
  const badge = document.createElement('span');
  badge.className = 'column-new-count';
  badge.hidden = true;
  badge.setAttribute('aria-hidden', 'true');
  link.append(badge);
  /** @type {ColumnView} */
  const view = { column, section, feed, link, badge, activity, subtitle, arrivals, messages: [...messages], nodes: new Map(), pending: 0, position: readingPosition(feed) };
  const jumpToLatest = () => {
    scrollToNewest(view);
    clearPending(view);
    updateArrivals(view);
    feed.focus({ preventScroll: true });
  };
  activity.addEventListener('click', jumpToLatest);
  feed.addEventListener('scroll', () => {
    // Reflow may fire scroll before ResizeObserver. Keep the pre-reflow anchor.
    if (paused && view.position.resized()) view.position.restore();
    else view.position.capture();
    if (isColumnVisible(view) && atNewestEdge(view)) clearPending(view);
    updateArrivals(view);
  });
  let composer = composers.get(column.id);
  if (mode === 'telegram' && column.chat) {
    if (!composer) {
      composer = createComposer(column.chat, { notify, beforeSend: () => {
        if (paused) { paused = false; updatePauseButton(); connect(); }
        const view = views.get(column.id);
        if (view) { scrollToNewest(view); clearPending(view); }
      } });
      composers.set(column.id, composer);
    } else composer.updateChat(column.chat);
  }
  section.append(header, feed);
  if (composer) section.append(composer.element);
  for (const message of view.messages) {
    const node = messageNode(view, message);
    view.nodes.set(message.key, node);
    feed.append(node);
  }
  link.title = column.title;
  link.setAttribute('aria-label', `Jump to ${column.title}`);
  link.addEventListener('click', () => {
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    feed.focus({ preventScroll: true });
  });
  nav.append(link);
  board.append(section);
  return view;
}

/** @param {ColumnView} view @returns {ScrollState} */
function scrollState(view) {
  const followNewest = !paused;
  const anchor = followNewest ? undefined : visibleAnchor(view);
  return { followNewest, anchorKey: anchor?.key, anchorOffset: anchor?.offset ?? 0, pending: view.pending };
}

/** @param {Snapshot} snapshot */
function renderSnapshot(snapshot) {
  reordering.cancel();
  // A snapshot rebuilds every column. Keep each reader's place and focus.
  const scroll = new Map([...views].map(([id, view]) => [id, scrollState(view)]));
  const previousViews = new Map(views);
  const focusedColumn = [...views].find(([, view]) => view.section.contains(document.activeElement))?.[0];
  const focusedElement = document.activeElement;
  const focusedHandle = focusedElement instanceof Element && focusedElement.classList.contains('column-drag-handle');
  const selection = focusedElement instanceof HTMLTextAreaElement ? [focusedElement.selectionStart, focusedElement.selectionEnd] : undefined;
  const horizontalScroll = board.scrollLeft;
  latest = snapshot;
  preferences.render(snapshot);
  board.dataset.layout = snapshot.settings?.layout ?? 'columns';
  const demo = snapshot.mode === 'demo';
  const populated = snapshot.columns.length > 0;
  empty.hidden = populated || !demo;
  board.hidden = !populated;
  element('load').hidden = populated || !demo;
  element('clear').hidden = !populated || !demo;
  add.hidden = !demo && snapshot.auth.state !== 'ready';
  add.setAttribute('aria-label', demo ? 'Load demo board' : 'Add column');
  add.title = demo ? 'Load demo board' : 'Add column';
  element('mode-badge').textContent = demo ? 'Demo mode' : 'Telegram · local';
  element('mode-badge').classList.toggle('live-badge', !demo);
  pause.hidden = !populated;
  element('easy-reading').hidden = !populated;
  element('column-count').textContent = populated ? `${snapshot.columns.length} ${snapshot.columns.length === 1 ? 'column' : 'columns'}` : 'A little space for everything';
  resetAvatars();
  feedSizes.disconnect();
  board.replaceChildren();
  nav.replaceChildren();
  views.clear();
  for (const id of composers.keys()) if (!snapshot.columns.some(column => column.id === id)) composers.delete(id);
  for (const column of snapshot.columns) {
    const messages = snapshot.feeds[column.id] ?? [];
    const previous = previousViews.get(column.id);
    const arrivals = previous?.arrivals ?? new ArrivalTracker();
    let missed = 0;
    if (previous) {
      const newestDate = Math.max(0, ...previous.messages.map(message => message.date));
      for (const message of messages) {
        if (!message.own && !previous.nodes.has(message.key) && message.date >= newestDate) {
          arrivals.add(message.key);
          missed++;
        }
      }
    }
    arrivals.retain(messages.map(message => message.key));
    const view = createColumn(column, messages, snapshot.mode, arrivals);
    views.set(column.id, view);
    const state = scroll.get(column.id);
    if (state) {
      view.pending = state.pending + missed;
      showPending(view);
    }
  }
  // Size all columns before positioning any feed: grid widths depend on the
  // entire board, and a later column can change earlier message heights.
  for (const [id, view] of views) {
    const state = scroll.get(id);
    if (!state || state.followNewest) scrollToNewest(view);
    else if (state.anchorKey) restoreAnchor(view, state.anchorKey, state.anchorOffset);
    feedSizes.observe(view.feed);
  }
  if (focusedElement instanceof HTMLElement && focusedElement.isConnected) {
    focusedElement.focus({ preventScroll: true });
    if (selection && focusedElement instanceof HTMLTextAreaElement) focusedElement.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
  } else if (focusedColumn) {
    const view = views.get(focusedColumn);
    if (focusedHandle) view?.section.querySelector('button')?.focus({ preventScroll: true });
    else view?.feed.focus({ preventScroll: true });
  }
  board.scrollLeft = horizontalScroll;
  acknowledgeVisibleColumns();
  login.render(snapshot);
  showConnection();
  reordering.refresh();
}

/** @param {ServerEvent} event */
function receive(event) {
  switch (event.type) {
    case 'snapshot': return renderSnapshot(event.data);
    case 'connection':
      if (latest) latest.connection = event.connection;
      return showConnection();
    case 'columnError':
      return notify(event.code === 'rateLimited'
        ? `Telegram asked this column to wait${event.retryAfter ? ` ${event.retryAfter} seconds` : ''}. Try opening it again shortly.`
        : 'Could not load this chat. Choose a chat to try again.');
    case 'message': {
      const view = views.get(event.columnId);
      if (view) addMessage(view, event.message);
      return;
    }
    case 'messageEdited': {
      const view = views.get(event.columnId);
      if (view) editMessage(view, event.message);
      return;
    }
    case 'messageReplaced': {
      const view = views.get(event.columnId);
      if (view) {
        if (view.nodes.has(event.oldKey)) editMessage(view, event.message, event.oldKey);
        else addMessage(view, event.message);
      }
      return;
    }
    case 'messagesDeleted': {
      const view = views.get(event.columnId);
      if (view) deleteMessages(view, event.keys);
      return;
    }
  }
}

function endSession() {
  reordering.cancel();
  feedSizes.disconnect();
  disconnect();
  connection('Session ended', false);
  clearSession();
  resetAvatars();
  preferences.reset();
  login.reset();
  views.clear();
  composers.clear();
  latest = undefined;
  board.replaceChildren();
  nav.replaceChildren();
  board.hidden = empty.hidden = true;
  for (const id of ['add', 'load', 'clear', 'pause', 'choose-chat', 'display-settings', 'easy-reading']) element(id).hidden = true;
  element('mode-badge').textContent = 'Local workspace';
  element('column-count').textContent = 'Open your startup link to continue';
  const panel = element('login-panel');
  const card = document.createElement('div');
  card.className = 'login-card';
  const title = document.createElement('h2');
  title.id = 'login-title';
  title.textContent = 'Open your startup link.';
  const description = document.createElement('p');
  description.className = 'login-description';
  description.textContent = 'Use the latest link printed by tgdeck, or restart the app to create a new one.';
  card.append(title, description);
  panel.append(card);
  panel.hidden = false;
}

// Reconnect with an authenticated fetch stream; credentials never enter an event URL.
async function recover() {
  const current = events;
  connection('Disconnected', false);
  let status = 0;
  try { status = (await apiFetch('/api/state')).status; } catch { /* The server is unreachable. */ }
  if (paused || events !== current) return;
  if (status === 401) {
    endSession();
    connection('Session ended', false);
    notify(errorText({ error: 'unauthorized' }));
    return;
  }
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
}

function connect() {
  window.clearTimeout(reconnectTimer);
  events?.abort();
  const controller = new AbortController();
  events = controller;
  void (async () => {
    try {
      const response = await apiFetch('/api/events', { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('Stream unavailable.');
      if (events !== controller || paused) { await response.body.cancel(); return; }
      showConnection();
      await readEvents(response.body, event => {
        if (events === controller && !paused) receive(event);
      });
    } catch { /* Recovery below distinguishes an expired session from a connection failure. */ }
    finally {
      if (events === controller && !controller.signal.aborted && !paused) void recover();
    }
  })();
}

function disconnect() {
  window.clearTimeout(reconnectTimer);
  events?.abort();
  events = undefined;
}

/** @param {'POST' | 'DELETE'} method */
async function changeBoard(method) {
  if (busy) return;
  busy = true;
  try {
    const response = await apiFetch('/api/demo/board', { method });
    if (!response.ok) throw new Error('Request failed.');
    renderSnapshot(await response.json());
  } catch { notify('Could not update the board. Check the local server and try again.'); }
  finally { busy = false; }
}

for (const button of [add, element('load'), element('explore')]) button.addEventListener('click', () => {
  if (latest?.mode === 'telegram') login.openPicker();
  else if (views.size) notify('The demo includes four sample columns. In Telegram mode, use Add column to choose your chats.');
  else void changeBoard('POST');
});
element('clear').addEventListener('click', () => { void changeBoard('DELETE'); });
pause.addEventListener('click', () => {
  paused = !paused;
  updatePauseButton();
  if (paused) { for (const view of views.values()) view.position.capture(); disconnect(); showConnection(); }
  else connect();
});
function updatePauseButton() {
  pause.textContent = paused ? 'Resume live updates' : 'Pause to read';
  pause.setAttribute('aria-pressed', String(paused));
}
board.addEventListener('scroll', acknowledgeVisibleColumns, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) followLatest(); });
window.addEventListener('resize', followLatest);
window.addEventListener('pagehide', disconnect);
window.addEventListener('pageshow', event => { if (event.persisted && !paused) connect(); });
onUnauthorized(endSession);
window.setInterval(() => { for (const view of views.values()) if (view.arrivals.size) updateArrivals(view); }, 1000);
connect();

/** @param {HTMLElement | undefined} card */
function removeCard(card) {
  if (!card) return;
  disposeAvatars(card);
  card.remove();
}
