# tgdeck

A local Telegram board inspired by TweetDeck: channels, conversations, searches
and mentions, side by side.

**Status: Telegram login, live columns, sending/replies and display customization.** Add chats and channels
side by side, remove columns, and restore the board after restarting. The fictional
demo works alongside the local Telegram setup/login flow. Media support
is still on the roadmap. This is an early public preview under active development.

Unofficial. Not affiliated with Telegram.

## Mac app

Build a standalone `tgdeck.app` with a native window, Dock icon, and Spotlight
launching. Node and TDLib are bundled, and your existing private account storage
is reused. See [Mac build and installation](docs/macos.md). Local builds are
ad-hoc signed; public binary distribution still needs signing and notarization.

## Try the demo

Use Node **24.12 or newer**, then:

```sh
npm ci
npm run demo
```

Open the one-time URL printed in your terminal. Click **Explore the demo** to
load four invented feeds. New messages appear every nine seconds. You can pause
updates, resume with a fresh snapshot, jump between columns and clear the board.
Nothing connects to Telegram, asks for credentials or sends a real message.

The URL signs this browser into the local server and redirects to a clean URL.
Afterwards, refresh the clean URL in the same tab. The initial link works once;
restart the server for a new link if you need to use another browser or reopen
a closed tab. The local session expires when the server restarts. Do not share
an unused startup link.

```sh
npm run demo -- --port 4311  # if the default 4310 is busy
npm run dev                # restart the server when source changes
npm run check              # type checks and Node tests
npm run guard              # scan tracked files and all local Git history
```

Demo state lives in memory; server restarts reset it. Reloading a browser
reconstructs the board from a current snapshot. All demo content is invented and
safe for screenshots.

## Connect Telegram

```sh
npm start
```

Open the one-time local URL printed in the terminal, then:

1. Get your own `api_id` and `api_hash` from
   [my.telegram.org/apps](https://my.telegram.org/apps). Enter them in the local
   setup form. Do not paste credentials or login codes into an issue or chat.
2. Enter the phone number of your existing Telegram account, with country code.
3. Enter the code Telegram sends you. It often arrives in Telegram on another
   signed-in device. The page indicates the delivery method provided by TDLib.
4. Enter your two-step verification password if requested. Optional email
   verification screens appear if Telegram requires them.
5. Click **+ Add column** (or **+** in the left rail), then choose a chat/channel.
   Repeat to add more columns side by side, up to 20. Each loads text/captions
   and receives new, edited and deleted messages. Chats already on the board
   are marked **Already added**. Scroll horizontally or use the left rail to
   jump between columns.
6. Click **×** in a column header to remove it from the board. This does not
   delete messages or leave the Telegram chat.
7. In chats where you can post, type at the bottom of the column and click
   **Send** or press **Enter**. **Shift+Enter** adds a new line. Click **Reply**
   on a message to reply to it; **×** or **Escape** cancels the reply target.

Sending supports plain text up to 4096 UTF-16 code units. Permissions are checked
again before sending. Channels require posting rights; forum chats require a
reply to select an existing topic. Secret chats, channel direct-message groups,
paid messages, attachments and rich text formatting are not supported yet.
Each outgoing message shows **Sending…**, **Sent** or **Not sent**. **Sent** means
Telegram accepted it, not that the recipient read it. Failed messages offer
**Use as draft**; nothing retries them automatically. An interrupted HTTP request
can be checked using the same request ID without sending twice while that ID is
retained in the running server's bounded cache.

Drafts stay in this page's memory across board updates. Removing their column,
reloading or closing the page discards them. Existing drafts remain intact when
a send is rejected. Viewing columns does not mark messages as read.
Read-only chats use a compact header label and leave the full column for messages.
Paid-message restrictions and unavailable sending permissions still show their specific explanation.

## Display and saved layouts

Open **Display & layouts** in the header to choose a light, dark or system theme,
one of four accent colors, 12–18 px message text, comfortable or compact spacing,
and flat or bubble conversations. Enable **Show profile pictures** to load small
avatars; otherwise the board uses initials. Click **Apply display settings** to
save. Colors and text size preview while the dialog is open.

New workspaces start with 16 px text and bubble conversations. **Easy reading**,
inside Display & layouts, raises smaller saved text
to 16 px and restores comfortable spacing, keeping your colors and layout.
Sender names, timestamps and controls remain readable even at smaller text sizes.
While updates are live, every column automatically follows its newest message,
including after a resize or reconnect. You do not need to scroll or click a
new-message badge to catch up. Chats follow the bottom; feed columns follow the top.
**Pause to read** holds the board so you can browse older messages without jumping.
The visible message stays anchored when the window or column width changes.
Long messages keep their sender and time visible while you read; timestamps and
arrival labels have their own row so they cannot squeeze the sender name.
**Resume live updates** catches every column up to the latest messages again.
New-message badges in the left rail help you catch up with offscreen columns;
they track this page's incoming updates, not Telegram's unread status.
Incoming messages also get a **New** label, accent stripe and tinted background,
with a clickable marker in the column header. Highlights remain until the card
comes into view, then clear after about 12 seconds. Resuming updates also marks
new arrivals received while paused. Initial history and your own sends are not
marked as new; none of these indicators sends Telegram read receipts.

The [UI review and repeatable synthetic scenarios](docs/ui-review.md) include
matching-viewport captures, measurements and the live/paused validation matrix.

Drag a column by its header or **⠿** handle and drop it at the highlighted position.
Hold near a board edge to scroll to columns offscreen. The order saves automatically.
For keyboard control, focus the handle, press **Space** or **Enter**, choose a position
with the arrow keys (or **Home/End**), then press **Space/Enter** to drop. **Escape**
cancels. Use a column's **⋯** menu to move it left/right or choose a narrow, medium or
wide column. Choose **Side by side**, **Two-row grid** or **Focus** in Display & layouts.
Individual widths apply to Side by side; Grid and Focus size columns automatically.
Name and save up to 12 layouts, each containing the current chats, column order,
widths and arrangement. **Use** restores a layout; **Delete** removes that saved
layout without closing the current board. Switching away from a column discards
its unsent draft. If a saved chat cannot load, the current board stays intact.

Live settings and layouts persist in the private `columns.json`, alongside the
selected chat IDs. Older layouts migrate when customization is first saved.
Demo settings and layouts stay in memory and reset with the demo server.
Avatar requests require the local authenticated session and a picture referenced
by a visible live column. Only small raster thumbnails are accepted, downloads
are bounded, and a limited memory cache replaces accumulating thumbnail files.
The demo uses invented vector portraits and never connects to Telegram.

API details, a random database encryption key and the selected chat IDs are saved
outside the repository. The TDLib database is encrypted with that key, and all
private files are protected by the data directory's permissions. These are local
files; disk encryption remains useful because the key lives on the same device.
tgdeck does not save phone numbers, login codes, email input or passwords;
TDLib maintains the account session it needs. A saved session and board are
restored when you restart the server. Existing single-column layouts are
preserved when upgrading.

Use **Change API details** to correct API credentials before login finishes, or
**Change phone number** to restart a phone login. Invalid codes/passwords show
fixed feedback; rate limits are enforced by the server. tgdeck supports existing
accounts and rejects new-account registration and currently unsupported
purchase/device-confirmation steps. Secret chats are excluded. Message media
downloads are not exposed yet; optional profile thumbnails are supported.

The pinned TDLib binaries support macOS 14+ (Intel/Apple Silicon), Linux
x64/arm64 (glibc/musl) and Windows x64. Other systems require a separate TDLib
build. See the [upstream package docs](https://github.com/eilvelia/tdl/tree/main/packages/prebuilt-tdlib).
The adapter uses [TDLib's auth states](https://core.telegram.org/tdlib/getting-started)
directly, through `tdl`, rather than prompting for secrets in the terminal.

## Privacy boundaries

- The server binds to `127.0.0.1` and verifies the exact local Host header.
- Account APIs, profile pictures and event streams require an explicit session
  header. The browser keeps its credential in origin-scoped, per-tab session
  storage; requests omit cookies and refuse redirects or other origins.
  The generic application shell contains no account data. Mutations also
  require an exact matching Origin header.
- A strict Content Security Policy prevents external scripts and resources.
  Message content is inserted as literal text through DOM nodes.
- At startup, the terminal shows only the mode and the local launch link. Error
  responses and logs do not include request URLs, message content, identifiers
  or raw errors.
- Demo mode uses no credentials or account data. Telegram mode loads the pinned
  native library only when API setup or a saved session requires it. Native
  logs and the SDK's debug logging are disabled before creating a client.

Live data is stored outside the repository:

| Platform | Live data directory |
| --- | --- |
| macOS | `~/Library/Application Support/tgdeck/` |
| Linux | `$XDG_DATA_HOME/tgdeck/`, or `~/.local/share/tgdeck/` |
| Windows | `%APPDATA%\tgdeck\` |

`TGDECK_DATA_DIR` overrides the live location and must be absolute. Demo storage,
when needed, uses a separate sibling ending in `-demo`, including with an
override. The current demo writes no user data. Repository-local directories
are rejected, including symlink aliases. POSIX directories use mode `0700`.
Credential/layout files use mode `0600`, and the server starts with umask `077`
on POSIX systems before TDLib creates files. On Windows, protection follows the
user's account/profile ACLs; POSIX modes do not establish Windows ACLs.

## Commit and push guards

Repository files and release material contain only source code and invented
data. Never add personal names, contact details, usernames, real chat/message
content, account identifiers, credentials, session files, personal machine paths
or real-account captures. This also applies to issue/PR text, CI logs, packaged
files and release assets. Contributor attribution uses the project name.
See [AGENTS.md](AGENTS.md) for the working rules.

`npm ci` / `npm install` installs repository-local hooks. Existing custom hook
paths are preserved; installation stops and asks you to integrate both guards
if another path is already configured. No global Git or Claude settings change.

- **Pre-commit:** scan the staged content, not the working copy.
- **Pre-push:** scan every outgoing commit tree, including intermediate versions
  of files that were later cleaned up. New branches scan all local ancestors.
- **CI:** type checks, tests and a full history scan on Node 24 and 26.

The guard blocks known TDLib/session/database paths, environment files, API hash
patterns, international phone patterns, email addresses, personal home paths and
private words. Email fixtures must use reserved `.invalid`, `.test` or
`example.com` / `example.net` / `example.org` domains. Add one private word
or phrase per line to `private-words.txt` in your **live data directory** for
usernames, chat titles or other identifiers. Empty lines and lines starting with
`#` are ignored. That file must never be committed. Guard output reports counts,
without printing matched content or filenames. A scanner failure blocks the
operation.

These are detection rules, not a guarantee against every possible secret. Review
staged changes and outgoing history yourself, especially before making the repo
public. Hooks can be bypassed; the CI scan has no access to your private word
list. The guard does not rewrite existing history or scan commit metadata.
Before release, review every published commit's author/committer details and
messages as well as its files. Existing history must be cleaned before the
repository is made public; cleaning only the latest files is insufficient.

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Private repo, privacy guards, typed protocol, safe local server, live demo board | Implemented |
| M1 | API setup, TDLib login, one live text chat column | Implemented |
| M2 | Real column CRUD, folders, search, mentions, drag, widths, pagination | Chat add/remove, drag ordering, widths and saved layouts implemented; remaining features planned |
| M3 | Explicit send and reply, with write-permission checks | Plain text and replies implemented |
| M4 | Photos, audio/video, files, stickers and cache limits | Planned |
| M5 | Settings, install guide and v0.1.0 | Display settings and local Mac app builds implemented; signed/notarized releases planned |

The demo columns demonstrate the layout and event flow; they do not
implement Telegram folders/search/mentions. Full text formatting arrives with
the real Telegram converter. All public screenshots and clips must use demo
mode. Milestone posts are drafts; the owner decides when to publish them.

## Project map

```text
src/           Protocol, demo and Telegram sources, TDLib conversion, local
               server, private storage, errors, logging and data paths
web/           Plain JavaScript, HTML and CSS; no build step
scripts/       Git privacy scanner and hook installation
test/          Synthetic fixtures and temporary Git/server integration tests
docs/          Approved design, milestone plans and milestone drafts
```

The [design](docs/superpowers/specs/2026-10-02-tgdeck-design.md) describes the full
target; the [M0 plan](docs/superpowers/plans/2026-10-05-m0-foundation.md) records the
foundation. The [M1 plan](docs/superpowers/plans/2026-10-05-m1-login.md) describes
login and the first live column. Auth, read and send capabilities are on
`TelegramSource`; files will be added with their working implementation.
Node runs erasable TypeScript directly, and `tsc` checks both
the server and browser JavaScript against `src/protocol.ts`.

## License

MIT. See [LICENSE](LICENSE).
