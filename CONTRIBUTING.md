# Contributing to NEO

Thanks for wanting to make NEO better. A few notes before you dive in.

## The philosophy

NEO exists because every writing app was eventually ruined by bloat. The bar for new features is not "would this be cool?" but "does this help a working author write, finish, and publish books?"

Good territory: bug fixes, performance, accessibility, better import/export precision, and platform polish (especially Windows and Linux, which I haven't tested much).

## How the code works

- `main.js` — the Electron main process: window, menus, file system, import/export, backups.
- `preload.js` — the bridge. Every capability the UI has is listed here.
- `app.js` — the entire UI: bookshelf, editor, outline, search, goals.
- `styles.css` — all styling, with CSS variables at the top.

Books are folders of plain files in `~/Documents/NEO Library`: `book.json` for metadata, `chapters/*.html` for text, JSON files for darlings/stickies.

## Ground rules

1. **Nothing interrupts a writer mid-sentence.** No popups, no squiggles, no notifications while typing.
2. **UI stays invisible until hovered.** 
3. **Words are never lost.** Any feature that removes text must route it somewhere recoverable.
4. **Plain files.** No databases, no proprietary formats. Future-proof, please!

## Practical bits

- Run from source: `npm install && npm start` (needs Node.js).
- Keep PRs focused — one feature or fix each.
- Describe the writer-facing behavior in your PR, not just the code. Think like an author, not a programmer!
- Bug reports: please include your OS, what you did, what happened, and the tail of `~/Documents/NEO Library/neo-errors.log` if it's a crash.

## Google Drive

The desktop Drive connection is in `google-drive.js`. The public OAuth client ID is configured there; for local development, `NEO_GOOGLE_DRIVE_CLIENT_ID` can override it. Before shipping, enable the Google Drive API and configure the OAuth consent screen in the publisher's Google Cloud project. The PKCE desktop flow does not require a client secret; `NEO_GOOGLE_DRIVE_CLIENT_SECRET` is an optional development override only. Do not commit private credentials.

NEO uses the `drive.file` scope, keeps the library in its own Drive folder, and stores the refresh token encrypted in app settings. A save queues a background sync; another computer's changes are checked every 30 seconds. Connected users can manually sync, create a timestamped backup or upload today's automatic backup, and import missing Drive files into the local library. Drive retains the three newest backups. Concurrently changed files are preserved as conflict copies rather than overwritten. Deletion sync is a shared Drive-folder setting and starts disabled; users can enable or disable it from File → Google Drive…. Verify OAuth consent and Drive API access with a test account before release.
