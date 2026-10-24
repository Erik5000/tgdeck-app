# tgdeck — design

- Date: 2026-10-02
- Status: approved; M0 continuation started on 2026-10-05.
- Update (2026-10-05): the owner requested a private GitHub repository. This supersedes the public-first-push plan below. Claude-specific team configuration is deferred; no Claude settings are changed by this continuation.

## 1. Goal

tgdeck is a local board for Telegram, like X Pro (TweetDeck). Columns sit side by side, and each column shows one feed. You read channels and reply in chats from the same board.

- tgdeck is open source (MIT). Other people install it and log in with their own Telegram account.
- The project is built in public. Progress goes out as posts on X.
- tgdeck is an unofficial client. The README says: "Unofficial. Not affiliated with Telegram."

## 2. Hard rules

1. **No personal Telegram data leaves the user's computer.** Personal Telegram data is: the phone number, the username, the `api_id` and `api_hash`, the TDLib database and session, chat names, contact names, message content and media. This data must never appear in the repo, in commits, in logs, in terminal output, in screenshots, in videos or in posts.
2. **Every user brings their own `api_id` and `api_hash`** from my.telegram.org. The repo contains no credentials.
3. **The board sends a message only when the user clicks send.** Nothing sends automatically.
4. **All public images and videos come from demo mode.**

## 3. Scope

### In version 1

- Four column types: chat, folder, search and mentions.
- Read all column types live.
- Send text and reply to a message.
- Show all media: photos, videos, GIFs, voice and video messages, files, static and video stickers, polls, locations and contacts.
- Demo mode with fake data.
- Settings.
- An install guide for other people.

### Not in version 1

- Send photos and files.
- Animated `.tgs` stickers. Version 1 shows their preview image.
- Mark messages as read in Telegram.
- Notifications.
- Reactions.
- Comment threads of channel posts.
- Secret chats.
- More than one account.
- A desktop app.

## 4. Architecture

Approach: a local web app with TDLib. A Node server runs on the user's computer. It uses TDLib, the official Telegram library, through the npm packages `tdl` and `prebuilt-tdlib`. The user opens the board in a browser.

```
browser (web/)  ⇄  local server (src/, 127.0.0.1 only)  ⇄  TDLib  ⇄  Telegram
                          │
                          └─ data folder outside the repo
```

### Stack

- Node 24 or later, with TypeScript that Node runs directly.
- Runtime dependencies: `tdl` and `prebuilt-tdlib`.
- Dev dependency: `typescript`, for type checks only.
- The browser code is plain JavaScript modules with `// @ts-check`. There is no build step.
- Tests use `node --test`.

### Units

Each unit has one job. Only the listed unit talks to TDLib.

| Unit | Job |
|---|---|
| `src/protocol.ts` | The contract. TypeScript types for all data between the server and the browser. |
| `src/source.ts` | The `Source` interface. `telegram.ts` and `demo.ts` both implement it. |
| `src/telegram.ts` | The only file that imports `tdl`. It handles login, updates and calls to TDLib. |
| `src/convert.ts` | Pure functions that convert TDLib objects to `protocol.ts` types. |
| `src/demo.ts` | A fake source. It makes invented chats and messages, and it adds a new message every few seconds. |
| `src/columns/chat.ts`, `folder.ts`, `search.ts`, `mentions.ts` | One file per column type. Each file exports `load()` for history and `matches()` for live messages. |
| `src/board.ts` | Reads and writes `columns.json`. Sends each update to the columns that match it. |
| `src/server.ts` | HTTP server: static files, SSE events, JSON actions and media with Range requests. It also does the security checks. |
| `src/paths.ts` | Finds the data folder for each operating system. |
| `src/log.ts` | The logger. It accepts only event names, counts, durations and fixed state values. |
| `src/cli.ts` | Starts the server in normal mode or in demo mode. |
| `scripts/guard.ts` | The privacy guard. `.githooks/pre-commit` and `.githooks/pre-push` call it. |
| `web/` | The board: `index.html`, `style.css` and JavaScript modules for the board, the columns, the messages, the media, the compose box and the dialogs. |

### The `Source` interface

Both sources give the same functions. The exact signatures go into the implementation plan.

- Auth: get the auth state and submit the next auth step.
- Updates: subscribe to new, edited and deleted messages, to connection changes and to folder changes.
- Read: chat history, list of folders, chats in a folder, chat search by name, message search and mention search.
- Write: check if the user can send in a chat, and send text with an optional reply target.
- Files: get file information, and get a byte range of a file.

### The data folder

The data folder is outside the repo:

- macOS: `~/Library/Application Support/tgdeck/`
- Linux: `~/.local/share/tgdeck/`
- Windows: `%APPDATA%\tgdeck\`
- The environment variable `TGDECK_DATA_DIR` overrides the location.

It contains:

- `tdlib/`: the TDLib database and the media cache
- `config.json`: the `api_id`, the `api_hash` and the settings
- `columns.json`: the columns
- `private-words.txt`: the private word list for the privacy guard

The folder has mode `0700`, and the files have mode `0600`.

## 5. Privacy and security

### Credentials and login

- On first start, a setup page in the browser asks for the `api_id` and `api_hash`. It links to my.telegram.org. The server saves both values in `config.json`.
- The login runs in the browser. The steps follow the TDLib auth states: phone number, code, 2FA password, and email steps if Telegram asks for them. tgdeck does not support new account registration.
- The phone number, the code and the password go directly to TDLib. tgdeck does not store them and does not log them.

### The privacy guard

- `npm install` runs a `prepare` script. The script sets `core.hooksPath` to `.githooks`.
- The pre-commit hook scans the staged files. It blocks a commit that contains any of these:
  - a 32-character hex string on the same line as `api_hash` or `apiHash`
  - a phone number: `+` and then 8 to 15 digits, with optional spaces or dashes
  - a TDLib file: `td.binlog`, a `.sqlite` file or any path under `tdlib/`
  - a line from `private-words.txt` in the data folder (case does not matter)
- A pre-push hook runs the same scan on all commits that the push sends. This also catches a commit made with `--no-verify`.
- The private word list never enters the repo. The user puts their phone number, username and chat names in it.

### Logs and terminal output

- Logs contain only event names, counts, durations and fixed state values. The type of the logger's input makes this rule hard to break.
- Logs contain no message text, no chat names, no chat IDs, no phone number and no codes.
- At start, the terminal shows only the URL of the board and the mode.

### The local server

- The server listens only on `127.0.0.1`.
- The server accepts a request only if the Host header is `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding.
- At each start, the server makes a random token. The start URL contains the token. The server sets the token as a cookie (`HttpOnly`, `SameSite=Strict`) and redirects to the clean URL.
- Every API request, SSE stream and media request needs the cookie. A POST request also needs a matching Origin header.
- Every page has a strict Content-Security-Policy: no inline scripts, and no scripts, styles or media from other servers.

### Untrusted message content

- The browser builds every message with DOM nodes and `textContent`. It never puts message content into `innerHTML`.
- Links work only with `https:`, `http:` and `tg:`. Links open in a new tab with `rel="noopener noreferrer"`.
- The server serves media only by TDLib file ID. A path from a request never reaches the file system.

## 6. Columns and data flow

### The message format

`protocol.ts` defines one `Message` object for all column types. It contains:

- a key: `<chatId>:<messageId>`
- the chat: ID, title and type
- the sender: name and avatar file
- the date and an edit flag
- the text with its formatting entities
- the media item, if there is one
- the reply target and the forward source, if there are any
- the topic name in a forum group

The browser shows these objects. It does not know TDLib.

### Column types

| Column | First load | Live messages |
|---|---|---|
| Chat | The latest 50 messages of the chat. | New messages in the chat. |
| Folder | The latest messages of all chats in a Telegram folder, merged by date. | New messages in those chats. The column follows changes to the folder in Telegram. |
| Search | Telegram's server search for the keywords, in all chats or in one folder. | New messages whose text or caption contains one of the keywords. Case does not matter. |
| Mentions | A search with the mention filter in the 20 groups with the most recent messages. | Messages that mention the user, or that reply to a message from the user. |

- "Load older" at the end of a column gets the next page of 50 messages.
- Server search and the live keyword match can give slightly different results. Server search matches words, and the live match uses substrings.
- In a forum group, a chat column shows the messages of all topics. Each message shows its topic name. A reply goes to the topic of the original message.

### Data flow

1. TDLib sends an update to `telegram.ts`.
2. `convert.ts` converts the update to the message format.
3. `board.ts` runs `matches()` for each column.
4. The server sends one SSE event for each column that matches. Edits and deletes use the same path.
5. When the browser connects or reconnects, the server sends a fresh snapshot of each column.

### SSE events (server to browser)

`auth`, `connection`, `columns`, `snapshot`, `message`, `messageEdited`, `messagesDeleted`, `columnError` and `settings`.

### Actions (browser to server)

| Action | Request |
|---|---|
| Submit an auth step | `POST /api/auth` |
| Save the `api_id` and `api_hash` | `POST /api/setup` |
| Add a column | `POST /api/columns` |
| Change a column (title, width, position) | `PATCH /api/columns/:id` |
| Remove a column | `DELETE /api/columns/:id` |
| Load older messages | `POST /api/columns/:id/older` |
| Send text or a reply | `POST /api/send` |
| Search chats by name | `GET /api/chats?query=` |
| List folders | `GET /api/folders` |
| Read or save settings | `GET /api/settings`, `PUT /api/settings` |
| Get media | `GET /media/:fileId` (with Range support) |

The exact payloads go into `protocol.ts` during milestone M0.

### Media

- Each media item first shows its small built-in preview from TDLib at once.
- The server downloads a photo when the browser asks for it. The browser asks only for photos that are visible.
- Video, voice and files download when the user clicks play or open.
- For video and audio, the server asks TDLib for the byte range that the player needs. A video starts before the full download ends.
- The media cache has a size limit. The default is 2 GB. TDLib deletes the oldest files first. The server checks the limit at start and then every hour.

### Sending

- A chat column has a compose box at the bottom. The box does not show if the user cannot write in that chat.
- Each message has a reply button. The button opens a compose box with that message as the reply target. This works in all four column types.

### Read status

tgdeck does not mark messages as read in Telegram. Unread counts on other devices do not change.

### Errors

- The header shows the connection state: connected, connecting or updating.
- If Telegram sends a rate limit, the column shows "Waiting N s" with the real wait time. It tries again after that time.
- Other TDLib errors show in the column that caused them. The other columns continue to work.
- When the SSE connection breaks, the browser reconnects and gets fresh snapshots.

## 7. The board

### Message order

- Chat columns use chat order, like Telegram. The newest message is at the bottom, and the compose box is below it.
- Folder, search and mentions columns use feed order, like X Pro. The newest message is at the top.

### Layout

- A narrow rail on the left has "Add column", "Settings" and the connection state. In demo mode, the board shows "Demo".
- Columns sit side by side. If they do not fit, the board scrolls horizontally.
- Each column has a width: narrow, medium (the default) or wide. The user sets it in the column menu.
- The user drags a column header to move the column.

### Add a column

1. Click "+" in the rail.
2. Select the type: chat, folder, search or mentions.
3. Set up the column:
   - Chat: search the chats by name and select one.
   - Folder: select a Telegram folder.
   - Search: type the keywords. Select all chats or one folder.
   - Mentions: no setup.

### New messages while the user scrolls

- Feed column: if the user scrolled down, new messages do not move the content. A label "N new ↑" shows at the top. A click on the label goes to the newest message.
- Chat column: if the user is at the bottom, the column follows new messages. If the user scrolled up, a label "N new ↓" shows at the bottom.

### Messages

- Feed columns use flat rows.
- Chat columns use flat rows by default. Own messages have a light tint and the name "You".
- A setting changes chat columns to bubbles. Own messages are then on the right in a colored bubble.

### Media in the board

- Photos show in the message. A click opens a full-screen viewer. Esc closes the viewer. The arrow keys go to the next or previous photo in the column.
- Videos and GIFs play in the message. GIFs play without sound when they are visible. A setting turns this off.
- Voice and video messages have a small player.
- Files show the name and size. A click downloads the file.
- Static and video stickers show as normal. Animated `.tgs` stickers show their preview image.
- Polls, locations and contacts show as a simple card.

### Text

- The board shows Telegram formatting: bold, italic, underline, strikethrough, code, pre, links, spoilers, mentions and hashtags.
- Custom emoji show as the normal emoji they are based on.

### Settings

| Setting | Values | Default |
|---|---|---|
| Message style in chat columns | flat rows, bubbles | flat rows |
| Theme | system, light, dark | system |
| GIF autoplay | on, off | on |
| Media cache limit | size in GB | 2 GB |

### Keys

- Enter sends the message. Shift+Enter adds a new line.
- Esc closes the viewer or the compose box.

## 8. Demo mode

- `npm run demo` starts the board with `demo.ts`. It needs no login and no `api_id`.
- The fake chats, people and messages are invented. They do not copy real channel names or real people.
- Demo mode has examples of all column types and all media kinds. The media files are generated or come from a free license, and they are in the repo.
- Demo mode adds a new message every few seconds, so live updates show in videos.
- Demo mode uses its own data folder, so it never touches the real data folder.

## 9. Tests

- Unit tests (`node --test`):
  - `matches()` of each column type
  - `convert.ts`: TDLib objects to the message format
  - the conversion from formatting entities to safe text parts, including the link check
  - the logger: it rejects text
  - the server: Host check, token cookie, Origin check, CSP header and Range requests
  - the privacy guard, with fake secrets and a fake private word list
- `tsc --noEmit` with `checkJs` checks `src/` and `web/` against `protocol.ts`.
- All fixtures are hand-written fake data. Nobody saves real TDLib traffic as a fixture.
- At the end of each milestone:
  - a check in the browser in demo mode
  - a check with the owner's real account, with no screenshots

## 10. Milestones

Each milestone gets its own implementation plan and ends with a draft X post.

| # | Result |
|---|---|
| M0 | Foundation: repo, README, MIT license, `protocol.ts`, the privacy guards, the demo source and an empty board |
| M1 | Setup page, login in the browser and one live chat column with text |
| M2 | All four column types, the "Add column" dialog, drag, widths and the "new" labels |
| M3 | Reply and send: compose box, reply button and the write access check |
| M4 | Full media: photos with the viewer, video and voice with streaming, files, stickers and the cache limit |
| M5 | Settings, the install guide and the v0.1.0 release |

## 11. Build in public

- The repository starts private, per the owner's 2026-10-05 request. The first push contains the privacy guards. Making it public later requires an explicit request.
- Automated commits use project attribution and a reserved `.invalid` email address.
- At the end of each milestone, Claude writes a draft post in `docs/devlog/`. The draft has the post text and a list of demo screenshots or videos to make. The owner posts it.

## 12. Agent team

The build uses Claude Code agent teams. The setup follows the docs at https://code.claude.com/docs/en/agent-teams.

| Role | Model | Owns |
|---|---|---|
| Lead (main session) | Opus 5.5 | The spec, the plan, `src/protocol.ts`, merges |
| `backend` | Sonnet 5.5 | `src/`, except `protocol.ts` |
| `ux` | Sonnet 5.5 | `web/` |
| `adversary` | Fable 5.1 | Nothing. It only reads and reviews. |

- The role files are `.claude/agents/backend.md`, `ux.md` and `adversary.md`. They go into the repo.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` goes into `.claude/settings.local.json`. That file stays out of the repo, and teams stay off in other projects.
- Teammates use the lead's effort level. The docs do not support a separate effort per teammate.
- Each teammate owns its own folder, so no two teammates edit the same file. The docs do not support a git worktree per teammate.
- The adversary reviews at three moments:
  1. Before the contract in `protocol.ts` is final: do the browser payloads match the server types?
  2. When a test fails twice: does the change fix the cause or only hide it?
  3. Before a task is done: did anybody miss an attack, a privacy leak or an edge case?
- A teammate must message the adversary at each of these moments. The project `CLAUDE.md` contains this rule.
- M0: the lead works alone, because the contract and the guards must exist first. The adversary reviews them.
- M1 to M5: `backend` and `ux` work in parallel. The adversary reviews.

## 13. Risks

| Risk | Plan |
|---|---|
| `prebuilt-tdlib` has binaries only for macOS (x64, arm64), Linux x64 and Windows x64. | The install guide lists the platforms. Other platforms must build TDLib themselves. |
| Telegram changes the TDLib API. | Pin the `prebuilt-tdlib` version. Update it on purpose. |
| A folder with many chats loads slowly or hits a rate limit. | Use the last message of each chat from TDLib's local data first. Load more only on "Load older". |
| A screenshot from normal mode leaks data. | All public images come from demo mode. The board shows "Demo" in demo mode. |
| Message content contains an XSS attack. | `textContent` only, a link check, a strict CSP and an adversary review. |
