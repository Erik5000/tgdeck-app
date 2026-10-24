import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, initial, safeLink } from '../web/render.js';
import { errorText } from '../web/login.js';
import { sendsOnEnter } from '../web/composer.js';

test('links allow only explicit web or Telegram protocols', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,test', '//example.test', 'file:///private', 'not a URL']) assert.equal(safeLink(link), undefined);
  assert.equal(safeLink('https://example.test'), 'https://example.test/');
  assert.equal(safeLink('tg://resolve?domain=demo'), 'tg://resolve?domain=demo');
});

test('avatar initials keep whole emoji and other multi-unit characters', () => {
  assert.equal(initial('Juno'), 'J');
  assert.equal(initial('🦊 Synthetic Fox'), '🦊');
  assert.equal(initial('👩‍💻 Synthetic Developer'), '👩‍💻');
  assert.equal(initial('  Mika'), 'M');
  assert.equal(initial(''), '');
});

test('message times add the date for older messages', () => {
  const date = new Date(2027, 0, 15, 9, 30);
  const today = formatTime(date, new Date(2027, 0, 15, 18, 0));
  const thisYear = formatTime(date, new Date(2027, 5, 1));
  const lastYear = formatTime(date, new Date(2028, 0, 15));
  assert.ok(!today.includes('2027') && !thisYear.includes('2027'));
  assert.notEqual(thisYear, today);
  assert.ok(thisYear.endsWith(today));
  assert.ok(lastYear.includes('2027'));
});

test('error text separates server errors from an unreachable server', () => {
  assert.match(errorText({ error: 'invalidCode' }), /code did not match/);
  assert.match(errorText({ error: 'rateLimited', retryAfter: 12 }), /12 seconds/);
  assert.match(errorText({ error: 'constructor' }), /Telegram is currently unavailable/);
  for (const failure of [new TypeError('Failed to fetch'), new SyntaxError('Unexpected token'), undefined]) {
    assert.match(errorText(failure), /local tgdeck server/);
  }
});

test('Enter sends, while Shift+Enter and IME composition never send', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false };
  assert.equal(sendsOnEnter(enter), true);
  assert.equal(sendsOnEnter({ ...enter, shiftKey: true }), false);
  assert.equal(sendsOnEnter({ ...enter, isComposing: true }), false);
  assert.equal(sendsOnEnter({ ...enter, keyCode: 229 }), false);
  assert.equal(sendsOnEnter({ ...enter, key: 'a' }), false);
});
