import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, startServer } from './server.ts';
import { TelegramSource } from './telegram.ts';
import { DemoSource } from './demo.ts';
import { dataDirectory, ensureDataDirectory } from './paths.ts';

const usage = `tgdeck

  npm start             Connect your Telegram account
  npm run demo          Open the fictional demo
  npm start -- --port ${DEFAULT_PORT + 1}`;

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  return /^\d+$/.test(value) && port >= 1 && port <= 65535 ? port : undefined;
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs({ options: { demo: { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean' } } }).values;
  } catch { options = undefined; }
  if (options?.help) {
    console.log(usage);
    return;
  }
  const port = parsePort(options?.port);
  if (!options || port === undefined) {
    console.error('Use --port with a number from 1 to 65535, and optionally --demo.');
    process.exitCode = 1;
    return;
  }
  process.umask(0o077);
  const demo = options.demo === true;
  try {
    const source = demo ? new DemoSource() : new TelegramSource(await ensureDataDirectory(dataDirectory(), fileURLToPath(new URL('..', import.meta.url))));
    const app = await startServer({ port, source });
    try { if (source instanceof TelegramSource) await source.start(); }
    catch (error) { await app.close(); throw error; }
    console.log(`tgdeck · ${demo ? 'Demo' : 'Telegram'}\nOpen this one-time link in your browser:\n${app.url}`);
    let closing = false;
    // The first signal closes cleanly. The handlers are removed after it,
    // so a second signal stops the process at once.
    const close = () => {
      if (closing) return;
      closing = true;
      app.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${port} is in use. Try --port ${port === 65535 ? port - 1 : port + 1}.`
      : 'Could not start tgdeck. Check the local data directory and installed TDLib packages.');
    process.exitCode = 1;
  }
}

await main();
