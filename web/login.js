// @ts-check
import { apiFetch } from './api.js';
/** @import { ApiError, AuthState, Chat, Snapshot } from '../src/protocol.ts' */

const SEARCH_DELAY_MS = 300;
const SERVER_UNREACHABLE = 'Could not reach the local tgdeck server. Check that it is still running, then try again.';
const CHAT_KINDS = { private: 'Private chat', group: 'Group', channel: 'Channel' };

/** @param {unknown} failure An ApiError from the server, or a network or parse error. */
export function errorText(failure) {
  if (!failure || typeof failure !== 'object' || !('error' in failure)) return SERVER_UNREACHABLE;
  const error = /** @type {ApiError} */ (failure);
  /** @type {Record<ApiError['error'], string>} */
  const messages = {
    unauthorized: 'Your local session expired. Open the new startup link from the terminal.',
    forbidden: 'This request could not be verified. Refresh the local page and try again.',
    notFound: 'This action is not available.',
    invalidRequest: 'Check the values and try again.',
    invalidState: 'The login step has changed, or another request is still running. Please try again.',
    invalidCredentials: 'Telegram rejected these API details. Choose “Change API details” and check both values.',
    invalidPhone: 'Enter a valid phone number in international format, including the country code.',
    invalidCode: 'That code did not match. Check the latest code and try again.',
    expiredCode: 'That code has expired. Use “Change phone number” to request a new login code.',
    invalidPassword: 'That two-step verification password did not match. Please try again.',
    invalidEmail: 'Telegram did not accept that email address. Check it and try again.',
    rateLimited: `Telegram asked you to wait ${error.retryAfter ?? 'a few'} seconds before trying again.`,
    unavailable: 'Telegram is currently unavailable. Check your connection and try again.',
    columnLimit: 'Your board has 20 columns. Remove a column before adding another.',
    sendForbidden: 'You don’t have permission to send messages in this chat.',
    paidMessage: 'This chat requires Telegram Stars. Paid messages are not supported here.',
    replyUnavailable: 'That message can no longer be replied to. Choose another message or cancel the reply.',
    replyRequired: 'Reply to a message to choose its forum topic.',
    sendUncertain: 'Delivery could not be confirmed. Check the conversation before composing another send. This request will not be sent again.',
    textTooLong: 'Keep your message within 4096 characters.',
  };
  return Object.hasOwn(messages, error.error) ? messages[error.error] : messages.unavailable;
}

/** @param {string} tag @param {string} text @param {string} [className] */
function node(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

/** @param {string} url @param {unknown} body */
async function post(url, body) {
  const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw /** @type {ApiError} */ (await response.json());
  return /** @type {Snapshot} */ (await response.json());
}

/** @param {{ onSnapshot: (snapshot: Snapshot) => void; onColumnAdded: (chatId: string) => void; notify: (text: string) => void }} callbacks */
export function initLogin(callbacks) {
  const panel = /** @type {HTMLElement} */ (document.getElementById('login-panel'));
  const picker = /** @type {HTMLElement} */ (document.getElementById('chat-picker'));
  const choose = /** @type {HTMLButtonElement} */ (document.getElementById('choose-chat'));
  /** @type {AuthState | undefined} */
  let currentAuth;
  let ready = false;
  let hadColumns = false;
  let lastScreen = '';
  let searchSequence = 0;
  let searchTimer = 0;
  /** @type {Set<string>} */
  let addedChatIds = new Set();

  /** @param {AuthState} auth @param {ApiError} [initialError] */
  function renderForm(auth, initialError) {
    panel.replaceChildren();
    const card = node('div', '', 'login-card');
    const badge = node('span', 'TELEGRAM · ON YOUR COMPUTER', 'eyebrow green');
    card.append(badge);
    const titles = { setup: 'Make it your workspace.', phone: 'Connect your Telegram.', code: 'Check for your code.', password: 'One last step.', email: 'Verify your email.', emailCode: 'Check your inbox.', starting: 'Connecting to Telegram…', ready: 'You’re connected.', closed: 'The session is closed.', unsupported: 'A different login step is needed.' };
    const title = node('h2', titles[auth.state]);
    title.id = 'login-title';
    title.tabIndex = -1;
    card.append(title);
    const descriptions = {
      setup: 'Bring your own Telegram API details. You only need to do this once.',
      phone: 'Enter the phone number of your existing Telegram account, including the country code.',
      code: auth.state === 'code' && auth.delivery === 'telegram' ? 'Telegram sent a code to your Telegram app on another signed-in device.'
        : auth.state === 'code' && auth.delivery === 'sms' ? 'Enter the login code Telegram sent by SMS.'
          : auth.state === 'code' && auth.delivery === 'call' ? 'Enter the login code delivered through the Telegram phone call.'
            : 'Enter the latest login code Telegram sent you. Check your Telegram app first.',
      password: 'Your account has two-step verification. Enter your existing Telegram password.',
      email: 'Telegram requires an email address to continue this login.',
      emailCode: 'Enter the verification code Telegram sent to your email address.',
      starting: 'Your local client is preparing a secure session. This can take a moment.',
      ready: 'Choose a chat to open your first column.',
      closed: 'Re-enter your API details to start a new local session.',
      unsupported: auth.state === 'unsupported' && auth.reason === 'registration'
        ? 'tgdeck supports existing accounts. Choose “Change phone number” and use an account already registered with Telegram.'
        : auth.state === 'unsupported' && auth.reason === 'premium'
          ? 'Telegram requested an in-app Premium purchase for this login. tgdeck cannot perform that step. Use the official Telegram app, then try again.'
          : 'Telegram requested confirmation on another device. Try the phone-number flow again, or complete the login in the official Telegram app.',
    };
    card.append(node('p', descriptions[auth.state], 'login-description'));
    if (auth.state === 'setup') {
      const link = document.createElement('a');
      link.href = 'https://my.telegram.org/apps';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Get API details at my.telegram.org ↗';
      link.className = 'setup-link';
      card.append(link);
    }
    const form = document.createElement('form');
    form.className = 'login-form';
    form.autocomplete = 'off';
    /** @type {HTMLInputElement[]} */
    const inputs = [];
    /** @param {string} name @param {string} labelText @param {string} type @param {string} [placeholder] */
    function field(name, labelText, type, placeholder = '') {
      const label = document.createElement('label');
      label.append(node('span', labelText));
      const input = document.createElement('input');
      input.name = name;
      input.type = type;
      input.placeholder = placeholder;
      input.required = true;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = 1024;
      if (name === 'apiId') { input.min = '1'; input.max = '2147483647'; input.step = '1'; }
      if (name === 'apiHash') { input.pattern = '[a-fA-F0-9]{32}'; input.maxLength = 32; }
      if (name === 'code' || name === 'emailCode') { input.autocomplete = 'one-time-code'; input.maxLength = 128; }
      label.append(input);
      form.append(label);
      inputs.push(input);
      return input;
    }
    if (auth.state === 'setup') {
      field('apiId', 'API ID', 'number', 'Your api_id');
      field('apiHash', 'API hash', 'password', 'Your api_hash');
    } else if (auth.state === 'phone' || auth.state === 'code' || auth.state === 'password' || auth.state === 'email' || auth.state === 'emailCode') {
      const labels = { phone: 'Phone number', code: 'Login code', password: 'Two-step verification password', email: 'Email address', emailCode: 'Email verification code' };
      const state = auth.state;
      field(state, labels[state], state === 'password' ? 'password' : state === 'email' ? 'email' : state === 'phone' ? 'tel' : 'text', state === 'phone' ? '+ country code and number' : '');
    }
    const error = node('p', '', 'login-error');
    error.setAttribute('role', 'alert');
    error.hidden = !initialError;
    if (initialError) error.textContent = errorText(initialError);
    const submitLabel = auth.state === 'setup' ? 'Save and continue →' : 'Continue →';
    const submit = document.createElement('button');
    submit.className = 'button primary large';
    submit.type = 'submit';
    submit.textContent = submitLabel;
    if (inputs.length) {
      form.append(error, submit);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        const first = inputs[0];
        if (!first) return;
        const payload = auth.state === 'setup'
          ? { apiId: Number(first.value), apiHash: inputs[1]?.value ?? '' }
          : { step: auth.state, value: first.value };
        // Remove submitted credentials from the DOM immediately. They never go
        // into local/session storage, URL parameters or console output.
        form.reset();
        for (const input of inputs) input.disabled = true;
        submit.disabled = true;
        submit.textContent = 'Connecting…';
        error.hidden = true;
        try { callbacks.onSnapshot(await post(auth.state === 'setup' ? '/api/setup' : '/api/auth', payload)); }
        catch (failure) {
          error.textContent = errorText(failure);
          error.hidden = false;
        } finally {
          for (const input of inputs) input.disabled = false;
          submit.disabled = false;
          submit.textContent = submitLabel;
          if (form.isConnected) first.focus();
        }
      });
      card.append(form);
    } else if (auth.state === 'starting') card.append(node('div', 'Waiting for Telegram', 'login-wait'));
    if (auth.state !== 'setup' && auth.state !== 'ready' && auth.state !== 'starting') {
      const actions = node('div', '', 'login-secondary');
      const edit = document.createElement('button');
      edit.className = 'button subtle';
      edit.textContent = 'Change API details';
      edit.addEventListener('click', () => renderForm({ state: 'setup' }));
      actions.append(edit);
      if (auth.state !== 'phone' && auth.state !== 'closed') {
        const phone = document.createElement('button');
        phone.className = 'button subtle';
        phone.textContent = 'Change phone number';
        phone.addEventListener('click', () => renderForm({ state: 'phone' }));
        actions.append(phone);
      }
      card.append(actions);
    }
    card.append(node('p', 'Your API details and session stay on this computer. Login codes and passwords are forwarded to Telegram and are not saved by tgdeck.', 'login-privacy'));
    panel.append(card);
    // Each step replaces the form. Move focus to the new step, so that
    // keyboard and screen reader users do not lose their place.
    (inputs[0] ?? title).focus();
  }

  function closePicker() {
    picker.hidden = true;
    searchSequence++;
    window.clearTimeout(searchTimer);
  }

  function openPicker() {
    if (!ready) return;
    picker.hidden = false;
    picker.replaceChildren();
    const card = node('div', '', 'picker-card');
    card.append(node('span', 'ADD A COLUMN', 'eyebrow green'));
    const title = node('h2', 'Pick a conversation.');
    title.id = 'picker-title';
    card.append(title, node('p', 'Add a chat or channel beside your existing columns.', 'login-description'));
    const label = document.createElement('label');
    label.className = 'picker-search';
    label.append(node('span', 'Search your chats'));
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Chat or channel name';
    input.autocomplete = 'off';
    input.maxLength = 100;
    label.append(input);
    const results = node('div', '', 'chat-results');
    results.setAttribute('role', 'group');
    results.setAttribute('aria-label', 'Chat results');
    const status = node('p', 'Loading your chats…', 'picker-status');
    status.setAttribute('role', 'status');
    card.append(label, status, results);
    const close = document.createElement('button');
    close.className = 'button subtle';
    close.textContent = 'Close picker';
    close.addEventListener('click', closePicker);
    card.append(close);
    picker.append(card);

    /** @param {boolean} disabled */
    function setResultsDisabled(disabled) {
      for (const result of results.querySelectorAll('button')) result.disabled = disabled || addedChatIds.has(result.dataset.chatId ?? '');
    }

    /** @param {Chat} chat */
    function resultButton(chat) {
      const button = document.createElement('button');
      button.className = 'chat-result';
      button.dataset.chatId = chat.id;
      button.disabled = addedChatIds.has(chat.id);
      button.append(node('span', chat.title, 'chat-result-title'), node('span', button.disabled ? 'Already added' : CHAT_KINDS[chat.type], 'chat-result-kind'));
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        setResultsDisabled(true);
        status.textContent = 'Adding column…';
        try {
          callbacks.onSnapshot(await post('/api/columns', { chatId: chat.id }));
          closePicker();
          callbacks.onColumnAdded(chat.id);
        } catch (failure) {
          const message = errorText(failure);
          status.textContent = message;
          if (picker.hidden) callbacks.notify(message);
          setResultsDisabled(false);
        }
      });
      return button;
    }

    /** @param {string} query */
    async function search(query) {
      const sequence = ++searchSequence;
      status.textContent = 'Loading your chats…';
      results.replaceChildren();
      try {
        const response = await apiFetch(`/api/chats?query=${encodeURIComponent(query)}`);
        if (!response.ok) throw await response.json();
        const data = /** @type {{ chats: Chat[] }} */ (await response.json());
        if (sequence !== searchSequence || picker.hidden) return;
        status.textContent = data.chats.length ? 'Select a chat to add a column.' : 'No chats found. Try another name.';
        results.append(...data.chats.map(resultButton));
      } catch (failure) {
        if (sequence === searchSequence && !picker.hidden) status.textContent = errorText(failure);
      }
    }
    input.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => { void search(input.value); }, SEARCH_DELAY_MS);
    });
    input.focus();
    void search('');
  }
  choose.addEventListener('click', openPicker);

  return {
    reset() { ready = false; currentAuth = undefined; lastScreen = ''; addedChatIds.clear(); closePicker(); picker.replaceChildren(); panel.replaceChildren(); panel.hidden = true; },
    /** @param {Snapshot} snapshot */
    render(snapshot) {
      addedChatIds = new Set(snapshot.columns.flatMap(column => column.filter.type === 'chat' ? [column.filter.chatId] : []));
      ready = snapshot.mode === 'telegram' && snapshot.auth.state === 'ready';
      choose.hidden = !ready;
      panel.hidden = snapshot.mode === 'demo' || ready;
      // A restored column replaces the picker that opened at login. Other
      // snapshots must not close a picker that the user opened.
      const columnAppeared = snapshot.columns.length > 0 && !hadColumns;
      hadColumns = snapshot.columns.length > 0;
      if (snapshot.mode === 'demo' || !ready || columnAppeared) closePicker();
      const screen = JSON.stringify([snapshot.auth, snapshot.authError]);
      if (!panel.hidden && screen !== lastScreen) renderForm(snapshot.auth, snapshot.authError);
      if (ready && currentAuth?.state !== 'ready' && !snapshot.columns.length) openPicker();
      currentAuth = snapshot.auth;
      lastScreen = screen;
    },
    openPicker,
  };
}
