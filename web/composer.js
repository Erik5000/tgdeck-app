// @ts-check
import { apiFetch } from './api.js';
/** @import { Chat, Message, SendInput } from '../src/protocol.ts' */
import { errorText } from './login.js';

/** @param {{ key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }} event */
export function sendsOnEnter(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Drafts live only in this page's memory. The same composer survives board snapshots.
 * @param {Chat} initialChat
 * @param {{ beforeSend: () => void; notify: (text: string) => void }} callbacks
 */
export function createComposer(initialChat, callbacks) {
  let chat = initialChat;
  let busy = false;
  /** @type {Message | undefined} */
  let reply;
  /** @type {SendInput | undefined} */
  let request;
  const element = document.createElement('div');
  element.className = 'composer';
  const restriction = document.createElement('p');
  restriction.className = 'composer-hint';
  const form = document.createElement('form');
  form.className = 'composer-form';
  const replyBar = document.createElement('div');
  replyBar.className = 'composer-reply';
  const replyText = document.createElement('span');
  const cancelReply = document.createElement('button');
  cancelReply.type = 'button';
  cancelReply.className = 'remove-column';
  cancelReply.textContent = '×';
  cancelReply.setAttribute('aria-label', 'Cancel reply');
  replyBar.append(replyText, cancelReply);
  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = 4096;
  input.autocomplete = 'off';
  const hint = document.createElement('p');
  hint.className = 'composer-hint';
  const actions = document.createElement('div');
  actions.className = 'composer-actions';
  const count = document.createElement('span');
  count.className = 'composer-count';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button primary';
  const status = document.createElement('p');
  status.className = 'composer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(count, submit);
  form.append(replyBar, input, hint, actions, status);
  element.append(restriction, form);

  function render() {
    form.hidden = !chat.canSend;
    restriction.textContent = chat.sendRestriction === 'paid' ? 'This chat requires Telegram Stars. Paid messages are not supported here.'
      : chat.sendRestriction === 'unavailable' ? 'Sending permissions are unavailable. Reopen the column to retry.'
        : '';
    restriction.hidden = chat.canSend || !restriction.textContent;
    element.hidden = !chat.canSend && restriction.hidden;
    input.placeholder = `Message ${chat.title}`;
    input.setAttribute('aria-label', `Message ${chat.title}`);
    input.disabled = busy || !chat.canSend;
    cancelReply.disabled = busy;
    replyBar.hidden = !reply;
    replyText.textContent = reply ? `Replying to ${reply.sender.name}: ${reply.text.slice(0, 120)}` : '';
    hint.textContent = chat.replyOnly && !reply ? 'Reply to a message to choose its topic.' : 'Enter to send · Shift+Enter for a new line';
    count.textContent = `${input.value.length} / 4096`;
    submit.textContent = busy ? 'Sending…' : 'Send';
    submit.disabled = busy || !chat.canSend || !input.value.trim() || input.value.length > 4096 || !!(chat.replyOnly && !reply);
    status.hidden = !status.textContent;
  }

  input.addEventListener('input', () => { request = undefined; status.textContent = ''; render(); });
  cancelReply.addEventListener('click', () => { reply = undefined; request = undefined; render(); input.focus(); });
  input.addEventListener('keydown', event => {
    if (sendsOnEnter(event)) { event.preventDefault(); if (!submit.disabled) form.requestSubmit(); }
    else if (event.key === 'Escape' && reply && !busy) { reply = undefined; request = undefined; render(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || busy) return;
    request ??= { requestId: crypto.randomUUID(), chatId: chat.id, text: input.value,
      ...(reply ? { replyTo: { chatId: chat.id, messageId: reply.id } } : {}) };
    busy = true;
    status.textContent = '';
    render();
    callbacks.beforeSend();
    try {
      const response = await apiFetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      if (!response.ok) {
        const failure = await response.json();
        if (failure.error !== 'sendUncertain') request = undefined;
        throw failure;
      }
      input.value = '';
      reply = undefined;
      request = undefined;
      status.textContent = '';
    } catch (failure) {
      status.textContent = failure && typeof failure === 'object' && 'error' in failure
        ? errorText(failure) : 'Connection interrupted. Press Send again to check the same send request.';
    } finally {
      busy = false;
      render();
      if (element.isConnected && chat.canSend) input.focus({ preventScroll: true });
    }
  });
  render();
  return {
    element,
    /** @param {Chat} value */
    updateChat(value) { chat = value; render(); },
    /** @param {Message} message */
    replyTo(message) {
      if (busy || !chat.canSend || message.delivery) return;
      reply = message;
      request = undefined;
      status.textContent = '';
      render();
      input.focus({ preventScroll: true });
    },
    /** @param {Message} message */
    restore(message) {
      if (busy || input.value.trim()) { callbacks.notify('Finish or clear your current draft before restoring this message.'); return; }
      input.value = message.text;
      // Restore a reply only when its original target is selected again by the user.
      reply = undefined;
      request = undefined;
      status.textContent = message.replyTo ? 'Draft restored. Select the original message to reply again.' : 'Draft restored. Press Send when ready.';
      render();
      input.focus({ preventScroll: true });
    },
  };
}
