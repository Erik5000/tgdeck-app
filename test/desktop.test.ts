import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sessionAuthorization } from './http-fixture.ts';

for (const stop of ['parent-pipe', 'SIGTERM'] as const) {
  test(`desktop demo starts privately and exits on ${stop}`, { timeout: 10000 }, async t => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/desktop.ts', import.meta.url)), '--demo'], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let output = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const ready = new Promise<{ type: string; url: string }>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 8192) { reject(new Error('Unexpected desktop protocol size')); return; }
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.split('\n')[0]!)); }
          catch { reject(new Error('Invalid desktop protocol')); }
        }
      });
    });
    const message = await ready;
    assert.equal(message.type, 'ready');
    const url = new URL(message.url);
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^[a-f0-9]{64}$/.test(url.searchParams.get('token') ?? ''));
    const bootstrap = await fetch(url, { redirect: 'manual' });
    const response = await fetch(`${url.origin}/api/state`, { headers: { Authorization: sessionAuthorization(bootstrap) } });
    const snapshot = await response.json() as { mode: string; columns: unknown[] };
    assert.equal(snapshot.mode, 'demo');
    assert.equal(snapshot.columns.length, 4);
    assert.equal((await fetch(`${url.origin}/api/state`)).status, 401);
    if (stop === 'parent-pipe') child.stdin.end();
    else child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    assert.ok(stderr.length === 0, 'Desktop startup must not write diagnostic or account content to stderr');
    await assert.rejects(fetch(`${url.origin}/api/state`));
  });
}
