// @ts-check
/** @import { ServerEvent } from '../src/protocol.ts' */

const SESSION_KEY = 'tgdeck-session';
let session = '';
/** @type {(() => void) | undefined} */
let unauthorized;

/** @param {() => void} callback */
export function onUnauthorized(callback) { unauthorized = callback; }

/** Consume the one-use redirect fragment before making any account requests. */
export function initializeSession() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.get('session');
  if (supplied !== null) {
    history.replaceState(null, '', location.pathname);
    if (/^[a-f\d]{64}$/.test(supplied)) session = supplied;
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, session);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* The current page still works when browser storage is disabled. */ }
  } else {
    try { session = sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { /* Use memory only. */ }
  }
}

export function clearSession() {
  session = '';
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage can be disabled. */ }
}

/** Keep the credential out of cookies, URLs, redirects and other origins.
 * @param {string} path @param {RequestInit} init @param {string} origin @param {string} token
 */
export function authenticatedRequest(path, init, origin, token) {
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.username || url.password) throw new Error('Invalid API destination.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { url, init: { ...init, headers, credentials: /** @type {RequestCredentials} */ ('omit'),
    redirect: /** @type {RequestRedirect} */ ('error'), cache: /** @type {RequestCache} */ ('no-store') } };
}

/** @param {string} path @param {RequestInit} [init] */
export async function apiFetch(path, init = {}) {
  const request = authenticatedRequest(path, init, location.origin, session);
  const response = await fetch(request.url, request.init);
  if (response.status === 401) { clearSession(); unauthorized?.(); }
  return response;
}

/** The server emits single-line JSON data frames and comment heartbeats.
 * @param {ReadableStream<Uint8Array>} stream @param {(event: ServerEvent) => void} receive
 */
export async function readEvents(stream, receive) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 16 * 1024 * 1024) throw new Error('Update exceeded the event limit.');
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith('data: ')) receive(/** @type {ServerEvent} */ (JSON.parse(frame.slice(6))));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
