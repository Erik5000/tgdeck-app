import { homedir } from 'node:os';
import { isAbsolute, resolve, dirname, join, relative, sep } from 'node:path';
import { mkdir, realpath, lstat, chmod } from 'node:fs/promises';

export function dataDirectory(options: {
  demo?: boolean; platform?: string; home?: string; env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const base = env.TGDECK_DATA_DIR || (platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'tgdeck')
    : platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'tgdeck')
      : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'tgdeck'));
  if (!isAbsolute(base)) throw new Error('Data directory must be absolute.');
  // A sibling, not a child: even overrides cannot share the live database.
  return options.demo ? `${resolve(base)}-demo` : resolve(base);
}

async function canonicalFuturePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalFuturePath(parent), relative(parent, path));
  }
}

export async function ensureDataDirectory(path: string, repository: string): Promise<string> {
  const target = await canonicalFuturePath(resolve(path));
  const root = await realpath(repository);
  const within = relative(root, target);
  // On Windows, a path on another drive is absolute relative to the repository.
  const outside = within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within);
  if (!outside) throw new Error('Data directory must be outside the repository.');
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!(await lstat(target)).isDirectory()) throw new Error('Invalid data directory.');
  await chmod(target, 0o700);
  return target;
}
