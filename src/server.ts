import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DemoSource } from './demo.ts';
import { TelegramSource } from './telegram.ts';
import { OperationError } from './errors.ts';
import { createLogger } from './log.ts';
import { validateSend } from './sending.ts';
import { validColumnId } from './preferences.ts';
import { authSteps, type ApiError, type AuthInput, type ServerEvent } from './protocol.ts';

export const DEFAULT_PORT = 4310;
const MAX_BODY_BYTES = 8192;
const MAX_QUERY_LENGTH = 100;
const MAX_STREAMS = 20;
// Events wait in this buffer while a tab reads slowly. One event can exceed
// the limit, so a large snapshot still reaches a tab that keeps up.
const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15000;

const assets = new Map<string, { file: string; type: string }>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/api.js', { file: 'api.js', type: 'text/javascript; charset=utf-8' }],
  ['/avatars.js', { file: 'avatars.js', type: 'text/javascript; charset=utf-8' }],
  ['/arrivals.js', { file: 'arrivals.js', type: 'text/javascript; charset=utf-8' }],
  ['/reading.js', { file: 'reading.js', type: 'text/javascript; charset=utf-8' }],
  ['/reorder.js', { file: 'reorder.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/render.js', { file: 'render.js', type: 'text/javascript; charset=utf-8' }],
  ['/login.js', { file: 'login.js', type: 'text/javascript; charset=utf-8' }],
  ['/composer.js', { file: 'composer.js', type: 'text/javascript; charset=utf-8' }],
  ['/preferences.js', { file: 'preferences.js', type: 'text/javascript; charset=utf-8' }],
]);

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function reject(response: ServerResponse, status: number, error: ApiError['error']): void {
  json(response, status, { error } satisfies ApiError);
}

function hasExactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
}

function isAuthStep(value: unknown): value is AuthInput['step'] {
  return (authSteps as readonly unknown[]).includes(value);
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new OperationError('invalidRequest');
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new OperationError('invalidRequest');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new OperationError('invalidRequest');
    parts.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body.');
    return value as Record<string, unknown>;
  } catch { throw new OperationError('invalidRequest'); }
}

export async function startServer(options: { port?: number; source?: DemoSource | TelegramSource } = {}) {
  const source = options.source ?? new DemoSource();
  const bootstrapToken = randomBytes(32).toString('hex');
  const sessionToken = randomBytes(32).toString('hex');
  let bootstrapUsed = false;
  let port = 0;
  const streams = new Set<ServerResponse>();
  const log = createLogger();

  function send(response: ServerResponse, chunk: string): void {
    if (response.destroyed) return;
    // A slow or suspended tab reconnects to a fresh snapshot instead of
    // buffering an unbounded history in server memory.
    if (response.writableLength > MAX_STREAM_BUFFER_BYTES) {
      response.destroy();
      return;
    }
    response.write(chunk);
  }

  function sendEvent(response: ServerResponse, event: ServerEvent): void {
    send(response, `data: ${JSON.stringify(event)}\n\n`);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reject(response, 403, 'forbidden');
    const origin = `http://${host}`;
    if ((request.headers.origin !== undefined && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') return reject(response, 403, 'forbidden');
    const rawUrl = request.url ?? '/';
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return reject(response, 400, 'invalidRequest');
    const url = new URL(rawUrl, origin);
    if (request.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (bootstrapUsed || !equal(url.searchParams.get('token') ?? '', bootstrapToken)) return reject(response, 401, 'unauthorized');
      bootstrapUsed = true;
      response.writeHead(303, {
        // Expire the legacy cookie; the new credential is isolated by browser origin.
        'Set-Cookie': `tgdeck_${port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        Location: `/#session=${sessionToken}`,
      });
      response.end();
      return;
    }
    const readOnly = request.method === 'GET' || request.method === 'HEAD';

    const asset = assets.get(url.pathname);
    if (asset && readOnly) {
      const content = await readFile(new URL(`../web/${asset.file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    if (!equal(request.headers.authorization ?? '', `Bearer ${sessionToken}`)) return reject(response, 401, 'unauthorized');
    if (!readOnly && request.headers.origin !== origin) return reject(response, 403, 'forbidden');
    if (url.pathname === '/api/state' && request.method === 'GET') return json(response, 200, source.snapshot());
    const avatarPath = /^\/api\/avatars\/([1-9]\d{0,10}|demo-[a-z]{1,20})$/.exec(url.pathname);
    if (avatarPath && request.method === 'GET') {
      const avatar = await source.avatar(avatarPath[1]!);
      response.writeHead(200, { 'Content-Type': avatar.mimeType, 'Content-Length': avatar.bytes.length });
      response.end(avatar.bytes);
      return;
    }
    if (url.pathname === '/api/settings' && request.method === 'PUT') {
      await source.updateSettings(await readJson(request));
      return json(response, 200, source.snapshot());
    }
    if (url.pathname.startsWith('/api/columns/') && request.method === 'PATCH') {
      const id = url.pathname.slice('/api/columns/'.length);
      if (!validColumnId(id)) throw new OperationError('invalidRequest');
      await source.updateColumn(id, await readJson(request));
      return json(response, 200, source.snapshot());
    }
    if (url.pathname === '/api/layouts' && request.method === 'POST') {
      await source.saveLayout(await readJson(request));
      return json(response, 200, source.snapshot());
    }
    const layoutPath = /^\/api\/layouts\/([a-f\d-]{36})(\/apply)?$/.exec(url.pathname);
    if (layoutPath && (request.method === 'POST' && layoutPath[2] || request.method === 'DELETE' && !layoutPath[2])) {
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) throw new OperationError('invalidRequest');
      if (request.method === 'POST') await source.applyLayout(layoutPath[1]!);
      else await source.deleteLayout(layoutPath[1]!);
      return json(response, 200, source.snapshot());
    }
    if (url.pathname === '/api/events' && request.method === 'GET') {
      if (streams.size >= MAX_STREAMS) return reject(response, 503, 'unavailable');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      streams.add(response);
      sendEvent(response, { type: 'snapshot', data: source.snapshot() });
      const unsubscribe = source.subscribe(event => sendEvent(response, event));
      const heartbeat = setInterval(() => send(response, ': keepalive\n\n'), HEARTBEAT_MS);
      heartbeat.unref();
      response.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(response);
      });
      return;
    }
    if (source instanceof TelegramSource) {
      if (url.pathname === '/api/send' && request.method === 'POST') {
        const body = await readJson(request, 32768);
        validateSend(body);
        await source.send(body);
        return json(response, 200, { accepted: true });
      }
      if (url.pathname === '/api/setup' && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasExactKeys(body, ['apiId', 'apiHash']) || typeof body.apiId !== 'number' || typeof body.apiHash !== 'string') throw new OperationError('invalidRequest');
        await source.setup({ apiId: body.apiId, apiHash: body.apiHash });
        return json(response, 200, source.snapshot());
      }
      if (url.pathname === '/api/auth' && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasExactKeys(body, ['step', 'value']) || !isAuthStep(body.step) || typeof body.value !== 'string') throw new OperationError('invalidRequest');
        await source.submitAuth({ step: body.step, value: body.value });
        return json(response, 200, source.snapshot());
      }
      if (url.pathname === '/api/chats' && request.method === 'GET') {
        const query = url.searchParams.get('query') ?? '';
        if (query.length > MAX_QUERY_LENGTH) throw new OperationError('invalidRequest');
        return json(response, 200, { chats: await source.listChats(query) });
      }
      if (url.pathname === '/api/columns' && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasExactKeys(body, ['chatId']) || typeof body.chatId !== 'string') throw new OperationError('invalidRequest');
        await source.addChat(body.chatId);
        return json(response, 200, source.snapshot());
      }
      if (url.pathname.startsWith('/api/columns/') && request.method === 'DELETE') {
        if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) throw new OperationError('invalidRequest');
        const id = url.pathname.slice('/api/columns/'.length);
        if (!/^live--?[1-9]\d*$/.test(id)) throw new OperationError('invalidRequest');
        await source.removeColumn(id);
        return json(response, 200, source.snapshot());
      }
    }
    if (source instanceof DemoSource && url.pathname === '/api/demo/board' && (request.method === 'POST' || request.method === 'DELETE')) {
      // These actions have no body. Reject payloads before any mutation.
      if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
        return reject(response, 400, 'invalidRequest');
      }
      if (request.method === 'POST') source.loadBoard();
      else source.clearBoard();
      return json(response, 200, source.snapshot());
    }
    reject(response, 404, 'notFound');
  }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (request, response) => {
    handle(request, response).catch(error => {
      if (error instanceof OperationError && !response.headersSent) {
        if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
        return json(response, error.status, { error: error.code, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } satisfies ApiError);
      }
      log('request_failed');
      if (!response.headersSent) reject(response, 500, 'unavailable');
      else response.destroy();
    });
  });

  async function close(): Promise<void> {
    // Stop the HTTP side first, so that no request reaches a closed source.
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const response of streams) response.destroy();
    server.closeAllConnections();
    try { await closed; } finally { await source.close(); }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) { await source.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('Server unavailable.');
  }
  port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/?token=${bootstrapToken}`,
    close,
  };
}
