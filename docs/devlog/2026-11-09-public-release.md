# Public release — tgdeck on GitHub

Draft only. No post has been published.

## Draft for X

Main post:

```
tgdeck is a local board for Telegram, like TweetDeck. Put chats and channels side by side, up to 20 columns. Send and reply in plain text. It runs on your computer. Open source, MIT. Early version, text only. Unofficial. Not affiliated with Telegram. <GITHUB-URL>
```

Optional reply:

```
Try it with no Telegram account: npm run demo. Node 24.12 or newer is needed. For a real account, use your own api_id and api_hash from my.telegram.org. Photos, video, files, search and mention columns come next.
```

## Image

- Use demo mode only, with the Demo mode badge visible.
- Exclude the startup URL, browser chrome and desktop.
- Ready image: `docs/ui-review/after-1280.jpg`.
- This image shows a merged channel feed, a keyword column and a "Mentioned you" label. These exist only in the demo.
- Alt text: Screenshot of the tgdeck demo board with invented data.
- Alternative: crop to the conversation column.

## Validation

- Synthetic clients and demo mode check the board, the columns and the send flow.
- No real account, chat or session appears in any test, fixture or image.
- The owner checks real-account behavior in the local app.
