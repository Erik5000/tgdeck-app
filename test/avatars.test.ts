import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as Td from 'tdlib-types';
import { AvatarCache, avatarRef, imageType } from '../src/avatars.ts';

test('avatar descriptors and raster types reject oversized and active formats', () => {
  assert.equal(avatarRef({ id: 7, size: 300000, expected_size: 300000 } as Td.file), undefined);
  assert.equal(avatarRef({ id: 7, size: 0, expected_size: 0 } as Td.file)?.id, '7');
  assert.equal(imageType(Buffer.from('<svg onload="alert(1)"></svg>')), undefined);
  assert.equal(imageType(Buffer.from('<html>fictional</html>')), undefined);
  assert.equal(imageType(Buffer.from([255, 216, 255, 0])), 'image/jpeg');
});

test('avatar reads stay inside the private thumbnail directory and use a bounded cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tgdeck-avatars-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'files'); await mkdir(root);
  const picture = Buffer.from([255, 216, 255, 0]);
  const path = join(root, 'fictional.jpg'); await writeFile(path, picture);
  const outside = join(directory, 'outside.jpg'); await writeFile(outside, picture);
  await symlink(outside, join(root, 'alias.jpg'));
  let returnedPath = path;
  let downloads = 0;
  let deletes = 0;
  const invoke = (async (query: { _: string }) => {
    if (query._ === 'deleteFile') { deletes++; return { _: 'ok' }; }
    downloads++;
    return { _: 'file', id: 7, size: picture.length, expected_size: picture.length,
      local: { path: returnedPath, is_downloading_completed: true } };
  }) as Td.Invoke;
  const ref = { id: '7', size: 4, mimeType: 'image/jpeg' };
  const cache = new AvatarCache(root);
  const [a, b] = await Promise.all([cache.get(ref, invoke), cache.get(ref, invoke)]);
  assert.deepEqual(a.bytes, picture); assert.deepEqual(a, b);
  await cache.get(ref, invoke);
  assert.equal(downloads, 1); assert.equal(deletes, 1);
  for (const badPath of [outside, join(root, 'alias.jpg')]) {
    cache.clear(); returnedPath = badPath;
    await assert.rejects(cache.get(ref, invoke), { code: 'notFound' });
  }
});
