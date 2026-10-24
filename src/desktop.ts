// Private pipe protocol for the macOS shell. Never log a session URL to a file.
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';
import { TelegramSource } from './telegram.ts';
import { DemoSource } from './demo.ts';
import { dataDirectory, ensureDataDirectory } from './paths.ts';

process.umask(0o077);
const demo = process.argv.slice(2).includes('--demo');
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await app?.close(); } finally { process.exit(0); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
// The parent owns this pipe: a crashed or force-quit window must not leave a
// background Telegram process holding the database open.
process.stdin.resume();
process.stdin.once('end', () => { void close(); });

try {
  const source = demo ? new DemoSource() : new TelegramSource(await ensureDataDirectory(dataDirectory(), fileURLToPath(new URL('..', import.meta.url))));
  // Claim the port before opening the account database. The terminal client
  // and desktop app deliberately share this port and cannot run together.
  app = await startServer({ port: demo ? 0 : 4310, source });
  if (source instanceof TelegramSource) await source.start();
  else source.loadBoard();
  if (!closing) process.stdout.write(`${JSON.stringify({ type: 'ready', url: app.url })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: 'error', code: (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'alreadyRunning' : 'startupFailed' })}\n`);
  await app?.close();
  process.exit(1);
}
