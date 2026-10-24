import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeClient } from '../src/telegram.ts';

test('pinned native TDLib loads and closes without credentials or a network login', async () => {
  const client = await createNativeClient();
  try {
    // getOption(version) works before setTdlibParameters. No account is used,
    // no database is opened, and no auth requests are sent to Telegram.
    const version = await client.invoke({ _: 'getOption', name: 'version' });
    assert.equal(version._, 'optionValueString');
    if (version._ === 'optionValueString') assert.match(version.value, /^1\.8\./);
  } finally { await client.close(); }
});
