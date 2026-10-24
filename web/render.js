// @ts-check
/** @import { Message } from '../src/protocol.ts' */
import { errorText } from './login.js';
import { observeAvatar } from './avatars.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

/** @param {string} url */
export function safeLink(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'tg:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}

/**
 * The first user-perceived character. A UTF-16 slice would split emoji and
 * other characters outside the Basic Multilingual Plane.
 * @param {string} name
 */
export function initial(name) {
  for (const { segment } of graphemes.segment(name.trim())) return segment;
  return '';
}

/**
 * The time for today's messages; older messages also show their date.
 * @param {Date} date @param {Date} [now]
 */
export function formatTime(date, now = new Date()) {
  const time = timeFormat.format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const day = (date.getFullYear() === now.getFullYear() ? dayFormat : yearFormat).format(date);
  return `${day}, ${time}`;
}

/** @param {string} text @param {string} className */
function span(text, className) {
  const element = document.createElement('span');
  element.textContent = text;
  element.className = className;
  return element;
}

/** @param {Message} message @param {boolean} isChat
 * @param {{ reply?: (message: Message) => void; restore?: (message: Message) => void; profilePictures?: boolean; newMessage?: boolean }} [actions] */
export function renderMessage(message, isChat, actions = {}) {
  const article = document.createElement('article');
  article.className = message.own ? 'message own' : 'message';
  article.classList.toggle('new-arrival', actions.newMessage === true);
  article.dataset.key = message.key;
  const header = document.createElement('div');
  header.className = 'message-header';
  const avatar = span(initial(message.sender.name), `avatar tone-${message.chat.type}`);
  avatar.setAttribute('aria-hidden', 'true');
  if (actions.profilePictures && message.sender.avatar) {
    const picture = document.createElement('img');
    picture.alt = '';
    picture.loading = 'lazy';
    picture.decoding = 'async';
    observeAvatar(picture, message.sender.avatar.id);
    picture.addEventListener('error', () => picture.remove(), { once: true });
    avatar.append(picture);
  }
  const identity = document.createElement('div');
  identity.className = 'message-identity';
  const senderLine = document.createElement('div');
  senderLine.className = 'sender-line';
  const newLabel = span('New', 'message-new-label');
  newLabel.hidden = !actions.newMessage;
  senderLine.append(span(message.sender.name, 'sender'));
  identity.append(senderLine);
  if (!isChat && message.chat.title !== message.sender.name) identity.append(span(message.chat.title, 'chat-name'));
  const date = new Date(message.date * 1000);
  const time = document.createElement('time');
  time.dateTime = date.toISOString();
  time.textContent = formatTime(date);
  time.title = fullFormat.format(date);
  const metadata = document.createElement('div');
  metadata.className = 'message-meta';
  metadata.append(time, newLabel);
  identity.append(metadata);
  header.append(avatar, identity);
  const text = document.createElement('p');
  text.className = 'message-text';
  // Literal text only. Entity formatting arrives with the full Telegram
  // converter, without inserting untrusted HTML.
  text.textContent = message.text;
  article.append(header, text);
  if (message.replyTo) article.append(span('↪ Reply', 'reply-tag'));
  if (message.edited) article.append(span('Edited', 'edit-tag'));
  if (message.mentioned) article.append(span('Mentioned you', 'mention-tag'));
  if (message.own) {
    const delivery = span(message.delivery === 'pending' ? 'Sending…' : message.delivery === 'failed'
      ? `Not sent · ${errorText(message.sendError ?? { error: 'unavailable' })}` : 'Sent', `delivery-status ${message.delivery ?? 'sent'}`);
    delivery.setAttribute('role', 'status');
    article.append(delivery);
  }
  if (actions.reply && !message.delivery) {
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'message-action';
    reply.textContent = 'Reply';
    reply.setAttribute('aria-label', `Reply to ${message.sender.name}`);
    reply.addEventListener('click', () => actions.reply?.(message));
    article.append(reply);
  }
  if (actions.restore && message.own && message.delivery === 'failed') {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'message-action';
    restore.textContent = 'Use as draft';
    restore.addEventListener('click', () => actions.restore?.(message));
    article.append(restore);
  }
  return article;
}
