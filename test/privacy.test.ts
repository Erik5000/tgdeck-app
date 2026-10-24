import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory, ensureDataDirectory } from '../src/paths.ts';
import { createLogger } from '../src/log.ts';

test('platform data defaults and demo overrides remain separate', () => {
  const home = '/fictional-home';
  assert.equal(dataDirectory({ platform: 'darwin', home, env: {} }), `${home}/Library/Application Support/tgdeck`);
  assert.equal(dataDirectory({ platform: 'linux', home, env: {} }), `${home}/.local/share/tgdeck`);
  assert.equal(dataDirectory({ platform: 'linux', home, env: { XDG_DATA_HOME: '/external-data' } }), '/external-data/tgdeck');
  assert.equal(dataDirectory({ demo: true, env: { TGDECK_DATA_DIR: '/external-data/board' } }), '/external-data/board-demo');
  assert.throws(() => dataDirectory({ env: { TGDECK_DATA_DIR: './data' } }), /absolute/);
});

test('data cannot be created in the repository or through a symlink into it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tgdeck-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await symlink(repo, join(dir, 'redirect'));
  await assert.rejects(ensureDataDirectory(join(repo, 'data'), repo), /outside/);
  await assert.rejects(ensureDataDirectory(join(dir, 'redirect', 'data'), repo), /outside/);
  const external = await ensureDataDirectory(join(dir, 'private'), repo);
  assert.equal((await stat(external)).mode & 0o777, 0o700);
});

test('logger rejects arbitrary text and fields at runtime', () => {
  const lines: string[] = [];
  const log = createLogger(line => lines.push(line));
  log('server_started', { count: 2 });
  assert.deepEqual(JSON.parse(lines[0]!), { event: 'server_started', count: 2 });
  // @ts-expect-error Deliberately exercise the runtime boundary.
  assert.throws(() => log('secret chat title'), /Invalid/);
  // @ts-expect-error Deliberately exercise the runtime boundary.
  assert.throws(() => log('request_failed', { text: 'private message' }), /Invalid/);
  assert.throws(() => log('request_failed', { count: NaN }), /Invalid/);
  assert.equal(lines.length, 1);
});
