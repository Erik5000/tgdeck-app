import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { OperationError } from './errors.ts';
import type { SetupInput } from './protocol.ts';

export type PrivateConfig = SetupInput & { databaseKey: string };
type PrivateFile = 'config.json' | 'columns.json';

const MAX_PRIVATE_FILE_BYTES = 65536;

export function validSetup(value: unknown): value is SetupInput {
  if (!value || typeof value !== 'object') return false;
  const { apiId, apiHash } = value as Partial<Record<keyof SetupInput, unknown>>;
  return Number.isInteger(apiId) && (apiId as number) > 0 && (apiId as number) <= 2147483647
    && typeof apiHash === 'string' && /^[a-f\d]{32}$/i.test(apiHash);
}

function validConfig(value: unknown): value is PrivateConfig {
  // 32 random bytes in base64.
  return validSetup(value) && 'databaseKey' in value
    && typeof value.databaseKey === 'string' && /^[A-Za-z\d+/]{43}=$/.test(value.databaseKey);
}

export async function readPrivateJson(directory: string, name: PrivateFile): Promise<unknown> {
  let file;
  try {
    file = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_PRIVATE_FILE_BYTES) throw new Error('Invalid private file.');
    if (process.platform !== 'win32') await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new OperationError('unavailable', 503);
  } finally { await file?.close(); }
}

export async function writePrivateJson(directory: string, name: PrivateFile, value: unknown): Promise<void> {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > MAX_PRIVATE_FILE_BYTES) throw new OperationError('invalidRequest');
  const target = join(directory, name);
  const temporary = join(directory, `.private-${randomBytes(12).toString('hex')}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new OperationError('unavailable', 503);
  }
}

export async function loadConfig(directory: string): Promise<PrivateConfig | undefined> {
  const value = await readPrivateJson(directory, 'config.json');
  if (value === undefined) return undefined;
  if (!validConfig(value)) throw new OperationError('unavailable', 503);
  return value;
}
