import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanFile, inspectRepository } from '../scripts/guard.ts';

test('privacy scanner detects constructed secrets without echoing them', () => {
  const hash = 'b'.repeat(32);
  assert.deepEqual(scanFile('source.ts', `apiHash: '${hash}'`), ['api-hash']);
  assert.deepEqual(scanFile('source.ts', `api_hash:\n  '${hash}'`), ['api-hash']);
  assert.deepEqual(scanFile('note.txt', '+' + '491234567890'), ['phone-number']);
  assert.deepEqual(scanFile('note.txt', '+' + '49 123-456-7890'), ['phone-number']);
  assert.deepEqual(scanFile('note.txt', 'Meet in Secret Orchard', ['secret orchard']), ['private-word']);
  assert.deepEqual(scanFile('Secret Orchard.txt', '', ['secret orchard']), ['private-word']);
  assert.deepEqual(scanFile('source.ts', 'Use apiHash from the browser.'), []);
});

test('privacy scanner blocks private filenames even when empty', () => {
  for (const path of ['data/file', 'TDLIB/cache', 'td.binlog', 'td.binlog.old', 'db.sqlite', 'db.sqlite-wal', 'db.session', 'config.json', 'columns.json', 'private-words.txt', '.env.local', 'id.key']) {
    assert.ok(scanFile(path, '').includes('private-file'));
  }
  assert.deepEqual(scanFile('.env.example', 'PORT=4310'), []);
});

test('privacy scanner blocks personal email addresses and home paths, with reserved fixture domains allowed', () => {
  for (const domain of ['synthetic-domain.dev', 'users.noreply.github.com', 'example.com.synthetic-domain.dev']) {
    assert.deepEqual(scanFile('note.txt', 'fictional@' + domain), ['email-address']);
  }
  for (const domain of ['example.invalid', 'demo.test', 'example.com', 'sub.example.net', 'EXAMPLE.ORG']) {
    assert.deepEqual(scanFile('fixture.ts', 'fictional@' + domain), []);
  }
  for (const path of [
    '/' + 'Users/fictional-person/project',
    '/' + 'home/fictional-person/project',
    'C:' + '\\Users\\fictional-person\\project',
    'C:' + '/' + 'Users/fictional-person/project',
  ]) assert.deepEqual(scanFile('note.txt', path), ['personal-path']);
  assert.deepEqual(scanFile('note.txt', '~/Library/Application Support/tgdeck'), []);
});

function repository(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'tgdeck-guard-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Demo Author');
  git('config', 'user.email', 'demo@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  return { cwd, git };
}

test('staged scanner reads the index even if the working file is clean', t => {
  const { cwd, git } = repository(t);
  writeFileSync(join(cwd, 'draft.txt'), 'apiHash: ' + 'a'.repeat(32));
  git('add', 'draft.txt');
  writeFileSync(join(cwd, 'draft.txt'), 'clean now');
  assert.equal(inspectRepository({ cwd, mode: 'staged' }).findings, 1);
});

test('push scanner finds secrets deleted in a later commit', t => {
  const { cwd, git } = repository(t);
  writeFileSync(join(cwd, 'draft.txt'), 'safe');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'draft.txt'), 'apiHash: ' + 'c'.repeat(32));
  git('add', '.'); git('commit', '-qm', 'bad intermediate revision');
  writeFileSync(join(cwd, 'draft.txt'), 'safe again');
  git('add', '.'); git('commit', '-qm', 'remove secret');
  const head = git('rev-parse', 'HEAD');
  const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
  assert.equal(inspectRepository({ cwd, mode: 'push', input }).findings, 1);
  assert.equal(inspectRepository({ cwd, mode: 'all' }).findings, 1);
});

test('new branches scan all ancestors and deleted refs send nothing', t => {
  const { cwd, git } = repository(t);
  writeFileSync(join(cwd, 'td.binlog'), '');
  git('add', '.'); git('commit', '-qm', 'private file');
  const head = git('rev-parse', 'HEAD');
  const zero = '0'.repeat(40);
  assert.equal(inspectRepository({ cwd, mode: 'push', input: `refs/heads/main ${head} refs/heads/main ${zero}` }).findings, 1);
  assert.deepEqual(inspectRepository({ cwd, mode: 'push', input: `(delete) ${zero} refs/heads/main ${head}` }), { files: 0, findings: 0 });
});

test('guard errors never echo private content or names', t => {
  const { cwd, git } = repository(t);
  const secretName = 'fictional-sensitive-name.txt';
  const hash = 'd'.repeat(32);
  writeFileSync(join(cwd, secretName), 'apiHash: ' + hash);
  git('add', '.');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/guard.ts', import.meta.url)), '--staged'], {
      cwd, env: { ...process.env, TGDECK_DATA_DIR: join(cwd, 'missing-wordlist') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('Expected scanner rejection');
  } catch (error) {
    const failure = error as { stderr: Buffer; status: number };
    assert.equal(failure.status, 1);
    const output = failure.stderr.toString();
    assert.match(output, /Privacy guard blocked/);
    assert.ok(!output.includes(hash));
    assert.ok(!output.includes(secretName));
  }
});
