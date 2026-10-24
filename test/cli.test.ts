import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [cli, ...args], { timeout: 10000 }, (_error, stdout, stderr) => {
      resolve({ code: child.exitCode, stdout, stderr });
    });
  });
}

async function occupiedPort(t: TestContext): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

test('help prints usage without starting a server', async () => {
  const result = await run('--help');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /npm run demo/);
});

test('invalid ports and unknown flags exit with a fixed message', async () => {
  for (const args of [['--port', 'abc'], ['--port=0'], ['--port=70000'], ['--port=1e3'], ['--port'], ['--verbose'], ['extra']]) {
    const result = await run('--demo', ...args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /Use --port with a number from 1 to 65535/);
  }
});

test('a port in use names the port and suggests another one', async t => {
  const port = await occupiedPort(t);
  const result = await run('--demo', `--port=${port}`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`Port ${port} is in use\\. Try --port ${port + 1}\\.`));
  assert.equal(result.stdout, '');
});
