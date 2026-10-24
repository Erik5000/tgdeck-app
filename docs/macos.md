# Mac app

tgdeck's Mac shell uses AppKit and WKWebView, with Node and the installed TDLib
runtime inside its app bundle. It opens a normal window, appears in the Dock,
and can be launched from Spotlight once installed in Applications.

## Build locally

Requirements: macOS 14 or newer, Apple Silicon or Intel matching the installed
dependencies, Xcode or its command-line tools, and Node 24.12 or newer.
Use an official self-contained macOS Node distribution; Homebrew's Node may
depend on libraries outside the app. Keep that distribution's LICENSE file.

```sh
npm ci
npm run build:mac -- --node /path/to/node/bin/node --node-license /path/to/node/LICENSE
```

Copy `dist/tgdeck.app` to your Applications folder. Open Spotlight, type
**tgdeck**, and press Return. A terminal is not required after installation.
The app is a snapshot of the source at build time; rebuild it after code changes.

To create a separate app using only invented in-memory content, add `--demo`:

```sh
npm run build:mac -- --node /path/to/node/bin/node --node-license /path/to/node/LICENSE --demo
```

The result is `dist/tgdeck Demo.app`. It never opens a Telegram account or its
data directory. Use this variant for screenshots, demonstrations, and UI checks.

## Lifecycle and privacy

- The normal app uses the same private Application Support directory as the CLI.
  Existing Telegram login, settings, and saved columns carry over.
- Stop the terminal version before opening the app. Both claim port 4310 before
  opening the account database; demo apps use a separate available loopback port.
- Closing the window leaves the app running. Reopening it from the Dock or
  Spotlight returns to the same window and preserves unsent drafts.
- **Quit tgdeck** (Command-Q) shuts down the local server and Telegram client.
  If the Mac shell crashes, closing its private pipe also shuts down the service.
- Credentials travel to the web view through a private startup pipe. The wrapper
  does not save startup links, backend output, web caches, or browser sessions.
- External links open in their default app after a click. They cannot replace
  the Telegram workspace inside its web view. No JavaScript-to-native bridge is exposed.
- Runtime dependencies and their upstream licenses are included. The build copies
  only application sources and a fixed dependency allowlist, never account data,
  Git history, tests, or captures.

## Distribution status

The local build is ad-hoc signed, suitable for local installation and testing.
It is **not Developer ID signed or Apple notarized**. Before advertising a
download for other Macs, produce and verify signed/notarized builds for each
supported architecture. Do not tell users to disable Gatekeeper.

Repository publication is a separate step: review all history, metadata, hosted
issues/PRs, CI logs and release assets before making it public. A source release
may document this local build without promising a notarized binary download.
