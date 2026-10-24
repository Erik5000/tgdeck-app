// Manual, repeatable UI review. All commands operate on invented in-memory data.
import { createInterface } from 'node:readline';
import { startServer } from '../src/server.ts';
import { defaultSettings } from '../src/preferences.ts';
import { UiFixture } from '../test/ui-fixture.ts';

const source = new UiFixture();
await source.updateSettings({ ...defaultSettings, theme: 'light', messageStyle: 'bubbles' });
const app = await startServer({ port: 4318, source });
console.log(`Synthetic UI review: ${app.url}\nCommands: reset, tick, burst, long, composer, snapshot, quit`);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  switch (line.trim()) {
    case 'reset': await source.reset(); break;
    case 'tick': source.tick(); break;
    case 'burst': for (let i = 0; i < 32; i++) source.tick(); break;
    case 'long': source.longMessage(); break;
    case 'composer': source.composer = true; source.publish({ type: 'snapshot', data: source.snapshot() }); break;
    case 'snapshot': source.publish({ type: 'snapshot', data: source.snapshot() }); break;
    case 'quit': input.close(); await app.close(); break;
    default: console.log('Unknown scenario.');
  }
}
