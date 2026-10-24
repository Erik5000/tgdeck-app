import { execFileSync } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { node: { type: 'string' }, 'node-license': { type: 'string' }, demo: { type: 'boolean' } } });
if (process.platform !== 'darwin') throw new Error('Build this app on macOS with Xcode or its command-line tools.');
const runtime = resolve(values.node ?? process.execPath);
if (!values['node-license']) throw new Error('Pass --node-license with the LICENSE from the same official Node release.');
const runtimeInfo = JSON.parse(execFileSync(runtime, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})'], { encoding: 'utf8' })) as { version: string; arch: string; platform: string };
const [major = 0, minor = 0] = runtimeInfo.version.split('.').map(Number);
if (runtimeInfo.platform !== 'darwin' || !['arm64', 'x64'].includes(runtimeInfo.arch) || major < 24 || major === 24 && minor < 12) throw new Error('Use a macOS Node runtime version 24.12 or newer.');
const architecture = runtimeInfo.arch;
const name = values.demo ? 'tgdeck Demo' : 'tgdeck';
function run(command: string, args: string[]) { return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function portableBinary(path: string) {
  const lines = run('/usr/bin/otool', ['-L', path]).split('\n').slice(1).map(line => line.trim().split(' ')[0]!).filter(Boolean);
  if (lines.some(line => !line.startsWith('/usr/lib/') && !line.startsWith('/System/Library/') && line !== '@rpath/libtdjson.dylib')) {
    throw new Error('The runtime links to non-system libraries. Use a self-contained official Node distribution.');
  }
}
portableBinary(runtime);
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(join(dist, '.macos-build-'));
const bundle = join(staging, 'tgdeck.app');
const resources = join(bundle, 'Contents', 'Resources');
const app = join(resources, 'app');
await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
await mkdir(join(resources, 'runtime'), { recursive: true });
await mkdir(app, { recursive: true });

try {
  // Explicit source allowlist. Never copy the checkout, its Git history, test
  // captures, private data, or build artifacts wholesale into a release.
  for (const folder of ['src', 'web']) {
    await mkdir(join(app, folder));
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|js|css|html)$/.test(entry.name)) throw new Error('Unexpected application source entry.');
      await copyFile(join(root, folder, entry.name), join(app, folder, entry.name));
    }
  }
  await copyFile(join(root, 'package.json'), join(app, 'package.json'));
  await copyFile(join(root, 'LICENSE'), join(resources, 'LICENSE'));
  await copyFile(resolve(values['node-license']), join(resources, 'runtime', 'LICENSE'));
  await copyFile(runtime, join(resources, 'runtime', 'node'));
  const packages = ['tdl', 'debug', 'ms', 'node-gyp-build', 'prebuilt-tdlib', `@prebuilt-tdlib/darwin-${architecture}`];
  for (const name of packages) {
    const from = join(root, 'node_modules', name);
    const to = join(app, 'node_modules', name);
    if (!(await lstat(from)).isDirectory()) throw new Error('Runtime dependencies must be installed with npm ci.');
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, filter: async path => {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlinks are not allowed in packaged dependencies.');
      const suffix = path.slice(from.length);
      if (suffix.startsWith('/prebuilds/')) return suffix.startsWith(`/prebuilds/darwin-${architecture}`);
      return !suffix.startsWith('/addon');
    } });
  }
  const sdk = run('/usr/bin/xcrun', ['--show-sdk-path']).trim();
  const target = `${architecture === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`;
  const compile = ['-O', '-sdk', sdk, '-target', target, '-module-cache-path', join(staging, 'modules'), '-file-prefix-map', `${root}=.`];
  run('/usr/bin/xcrun', ['swiftc', ...compile, '-module-name', 'Tgdeck', 'macos/App.swift', '-o', join(bundle, 'Contents', 'MacOS', 'tgdeck')]);
  run('/usr/bin/xcrun', ['swiftc', ...compile, '-module-name', 'TgdeckIcon', 'macos/Icon.swift', '-o', join(staging, 'icon')]);
  run(join(staging, 'icon'), [join(staging, 'AppIcon.iconset')]);
  run('/usr/bin/iconutil', ['-c', 'icns', join(staging, 'AppIcon.iconset'), '-o', join(resources, 'AppIcon.icns')]);
  await writeFile(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>app.tgdeck.${values.demo ? 'demo' : 'desktop'}</string>
<key>TgdeckDemoMode</key><${values.demo ? 'true' : 'false'}/>
<key>CFBundleExecutable</key><string>tgdeck</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.social-networking</string>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>tgdeck contributors. Unofficial; not affiliated with Telegram.</string>
</dict></plist>`);
  for (const binary of [join(resources, 'runtime', 'node'), join(app, 'node_modules', 'tdl', 'prebuilds', `darwin-${architecture}`, 'tdl.node'),
    join(app, 'node_modules', '@prebuilt-tdlib', `darwin-${architecture}`, 'libtdjson.dylib')]) {
    portableBinary(binary);
    run('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
  }
  await writeFile(join(resources, 'build-info.json'), `${JSON.stringify({ appVersion: '0.1.0', architecture, nodeVersion: runtimeInfo.version,
    nodeSha256: createHash('sha256').update(await readFile(join(resources, 'runtime', 'node'))).digest('hex'), distribution: 'local-ad-hoc' }, null, 2)}\n`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  // This fixed generated destination is owned by this build script.
  const destination = join(dist, `${name}.app`);
  if (await stat(destination).catch(() => undefined)) await rm(destination, { recursive: true });
  await cp(bundle, destination, { recursive: true });
  console.log(`Built dist/${name}.app (${architecture}, local ad-hoc signing).`);
  console.log('For distribution to other Macs, use Developer ID signing and Apple notarization.');
} finally { await rm(staging, { recursive: true, force: true }); }
