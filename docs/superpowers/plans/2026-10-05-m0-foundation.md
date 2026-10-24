# M0: a private, runnable foundation

The October 2 session ended after design approval and before this plan. The
October 5 continuation requests a **private** GitHub repository, overriding
the original first-push visibility. The intended MIT license stays in place.

## Deliverable

A no-build Node/TypeScript server and plain JavaScript board, runnable with
`npm run demo`. Start with an empty board; an explicit “Load demo board” action
shows invented feeds with live updates. No Telegram dependency, login or real
account access is needed for M0. Real login and TDLib integration are M1.

## Implementation sequence

1. Add package scripts, pinned type-check dependencies, MIT license and README.
2. Define the shared wire types and a source interface. Implement only the M0
   operations; reserve discriminated types for later auth, columns and media.
3. Add external data-directory resolution, separate demo storage and a logger
   with a closed vocabulary and runtime validation. Reject repository-local
   data paths, including paths redirected into the repo by symlinks.
4. Add staged-content and outgoing-history privacy scanners. Install pre-commit
   and pre-push hooks without changing global Git or Claude settings. Reject
   known session files, API hash and international phone patterns, and private
   words; never print the matching content or filenames.
5. Implement an in-memory fake source, snapshot/reconnect events and bounded
   live history. No demo action can submit a Telegram message.
6. Serve the board on loopback only, with exact Host checks, a one-use bootstrap
   token, HttpOnly/SameSite cookies, Origin validation for mutations and SSE,
   no-store responses, static-file allowlisting and a restrictive CSP.
7. Build an accessible responsive empty state and demo feed preview. Render all
   dynamic content through DOM/textContent; keep the Demo label always visible.
8. Test privacy guards against actual temporary Git repositories, server trust
   boundaries, source snapshots and cleanup, data paths and log validation.
   Type-check browser code against the shared protocol. Inspect the demo in a
   browser. Scan all existing history before the first private push.
9. Write a draft milestone post, commit, create the repository privately and
   push. Verify the remote visibility and pushed commit.

## Scope and handoff

- M0 does not persist the demo layout; restart/refresh can safely reconstruct it.
- M1 adds credentials/setup, TDLib auth and one real chat column.
- M2 adds real column CRUD, filters, pagination, drag and width controls.
- M3 adds explicit send/reply; M4 adds media; M5 adds settings and release docs.
- No changes to Claude agent profiles or global/local Claude settings in this
  continuation. The old Claude-specific team configuration is deferred.
- Screenshots and fixtures contain only invented demo content. No X post is
  published automatically. No real-account browser check is possible in M0.
