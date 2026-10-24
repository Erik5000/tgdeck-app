import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../src/paths.ts';

export type Finding = 'private-file' | 'api-hash' | 'phone-number' | 'email-address' | 'personal-path' | 'private-word';

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const BLOB_BATCH_SIZE = 256;

function matchesPrivateWord(value: string, privateWords: string[]): boolean {
  const lower = value.toLowerCase();
  return privateWords.some(word => word.trim() !== '' && lower.includes(word.toLowerCase()));
}

export function scanPath(path: string, privateWords: string[] = []): Finding[] {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.split('/').at(-1) ?? '';
  const findings: Finding[] = [];
  if (/(^|\/)(tdlib|data)(\/|$)/.test(normalized)
    || /^td\.binlog/.test(basename)
    || /\.(sqlite(?:3)?(?:-wal|-shm)?|db|session(?:-journal)?)$/.test(basename)
    || ['config.json', 'columns.json', 'private-words.txt'].includes(basename)
    || /^\.env(?:\.|$)/.test(basename) && basename !== '.env.example'
    || /\.(pem|key)$/.test(basename)) findings.push('private-file');
  if (matchesPrivateWord(normalized, privateWords)) findings.push('private-word');
  return findings;
}

export function scanContent(content: Buffer | string, privateWords: string[] = []): Finding[] {
  const text = content.toString();
  const findings: Finding[] = [];
  if (/(?:api_hash|apiHash)[^\r\n]{0,160}[a-f\d]{32}(?![a-f\d])/i.test(text)
    || /(?:api_hash|apiHash)["'\s:=]+[a-f\d]{32}(?![a-f\d])/i.test(text)) findings.push('api-hash');
  if (/(?<![\w+])\+(?:\d[ -]?){7,14}\d(?![ -]?\d)/.test(text)) findings.push('phone-number');
  const emails = text.matchAll(/(?<![\w.+-])[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})(?![\w-])/gi);
  if ([...emails].some(([, domain]) => !/(?:^|\.)(?:example\.(?:com|net|org)|invalid|test)$/i.test(domain!))) {
    findings.push('email-address');
  }
  if (/(?:\/Users\/|\/home\/)[^\s/'"`]+|[a-z]:[\\/]+Users[\\/]+[^\s\\/'"`]+/i.test(text)) {
    findings.push('personal-path');
  }
  if (matchesPrivateWord(text, privateWords)) findings.push('private-word');
  return findings;
}

export function scanFile(path: string, content: Buffer | string, privateWords: string[] = []): Finding[] {
  return [...new Set([...scanPath(path, privateWords), ...scanContent(content, privateWords)])];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Reads blobs through one `git cat-file --batch` process per batch, not one
// process per file version. Each answer is "<hash> blob <size>\n<content>\n".
function readBlobs(hashes: string[], cwd: string): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  for (let start = 0; start < hashes.length; start += BLOB_BATCH_SIZE) {
    const batch = hashes.slice(start, start + BLOB_BATCH_SIZE);
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd, input: `${batch.join('\n')}\n`, maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let offset = 0;
    for (const hash of batch) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) throw new Error('Invalid Git object.');
      const [name, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
      // A missing object answers "<hash> missing". Fail closed.
      if (name !== hash || type !== 'blob' || !size || !/^\d+$/.test(size)) throw new Error('Invalid Git object.');
      const end = newline + 1 + Number(size);
      if (end >= output.length || output[end] !== 0x0a) throw new Error('Invalid Git object.');
      blobs.set(hash, output.subarray(newline + 1, end));
      offset = end + 1;
    }
  }
  return blobs;
}

export function inspectRepository(options: {
  cwd: string; mode: 'staged' | 'all' | 'push'; input?: string; privateWords?: string[];
}): { files: number; findings: number } {
  const { cwd, mode, privateWords = [] } = options;
  const entries = new Map<string, { hash: string; path: string }>();
  const addEntries = (output: string) => {
    for (const entry of output.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Invalid Git entry.');
      const metadata = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      // ls-tree prints "<mode> blob <hash>"; ls-files --stage prints "<mode> <hash> <stage>".
      const hash = metadata[1] === 'blob' ? metadata[2]! : metadata[1]!;
      // Submodules are opaque to this guard; fail closed rather than skip.
      if (metadata[0] === '160000') throw new Error('Submodules require separate review.');
      entries.set(`${hash}:${path}`, { hash, path });
    }
  };
  if (mode === 'staged') {
    const changed = new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd).split('\0'));
    addEntries(git(['ls-files', '--stage', '-z'], cwd));
    for (const [key, entry] of entries) if (!changed.has(entry.path)) entries.delete(key);
  } else {
    const revisions = new Set<string>();
    if (mode === 'all') {
      for (const revision of git(['rev-list', '--all'], cwd).trim().split('\n')) if (revision) revisions.add(revision);
      addEntries(git(['ls-files', '--stage', '-z'], cwd));
    } else {
      for (const line of (options.input ?? '').split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 4) throw new Error('Invalid push input.');
        const local = parts[1]!;
        const remote = parts[3]!;
        if (!/^[a-f\d]{40,64}$/.test(local) || !/^[a-f\d]{40,64}$/.test(remote)) throw new Error('Invalid revision.');
        if (/^0+$/.test(local)) continue; // Ref deletion sends no content.
        const args = ['rev-list', local];
        if (!/^0+$/.test(remote)) {
          try { git(['cat-file', '-e', `${remote}^{commit}`], cwd); args.push(`^${remote}`); }
          catch { /* Unknown remote history: scan all local ancestry. */ }
        }
        for (const revision of git(args, cwd).trim().split('\n')) if (revision) revisions.add(revision);
      }
    }
    for (const revision of revisions) addEntries(git(['ls-tree', '-r', '-z', revision], cwd));
  }
  const blobs = readBlobs([...new Set([...entries.values()].map(entry => entry.hash))], cwd);
  // Scan each unique blob once, then combine with the checks of each path.
  const contentFindings = new Map<string, Finding[]>();
  for (const [hash, content] of blobs) contentFindings.set(hash, scanContent(content, privateWords));
  let findings = 0;
  for (const { hash, path } of entries.values()) {
    findings += new Set([...scanPath(path, privateWords), ...contentFindings.get(hash)!]).size;
  }
  return { files: entries.size, findings };
}

function main(): void {
  try {
    const flag = process.argv[2];
    const mode = flag === '--staged' ? 'staged' : flag === '--all' ? 'all' : flag === '--push' ? 'push' : undefined;
    if (!mode) throw new Error('Invalid mode.');
    let privateWords: string[] = [];
    try {
      privateWords = readFileSync(join(dataDirectory(), 'private-words.txt'), 'utf8')
        .split(/\r?\n/).map(word => word.trim()).filter(word => word && !word.startsWith('#'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const result = inspectRepository({ cwd: process.cwd(), mode, privateWords, input: mode === 'push' ? readFileSync(0, 'utf8') : undefined });
    if (result.findings) {
      console.error(`Privacy guard blocked this operation (${result.findings} findings). Review private files, credentials, phone/email patterns, personal paths and your private word list locally. Matching content and paths are intentionally omitted.`);
      process.exitCode = 1;
    } else console.log(`Privacy guard passed (${result.files} file versions checked).`);
  } catch {
    console.error('Privacy guard could not complete. Operation blocked; check Git, the data directory and private word list locally.');
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
