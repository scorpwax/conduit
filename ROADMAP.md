# Roadmap

Ideas and planned improvements that aren't built yet. Not a commitment or a timeline —
just a place to track what's next so ideas don't get lost between sessions.

Once an item ships, it's marked `✅ COMPLETE vX.Y.Z –` at the front of its bullet (the
version it shipped in) instead of being deleted, so this file also works as a record
of when things landed.

## Settings

- **✅ COMPLETE v1.27.0 – Adaptive Connection Speed** — "Connection Speed" (Settings) currently sets
  `transferConcurrency`, a static number of parallel file transfers (default 5 at
  "Balanced"). It's not bandwidth-aware — Conduit never measures actual throughput.
  On a slow or flaky connection, maxing this out doesn't add speed that isn't there;
  it just splits the same limited pipe into more streams, increasing the chance of
  timeouts/retries and making individual files feel slower and less predictable.
  Idea: add an "Adaptive" mode that watches for repeated timeouts/retries and backs
  off concurrency automatically, exposed as an option next to the existing Connection
  Speed control in `SettingsModal.tsx`. Logic would live in
  `src/main/transfer/engine.ts`.
  _(Raised by a beta tester, 2026-08-26.)_
- **Bandwidth throttle** — cap transfer speed (Mbps) so Conduit transfers don't hog
  the connection while doing video calls or other network use alongside it.
- **✅ COMPLETE v1.28.0 – Checksum verification toggle** — optional MD5/ETag compare on top of the existing
  size-verify, for extra integrity assurance on critical media files (BRAW/R3D/etc.).
  Shipped as multipart-aware checksum verification (built into Compare's existing
  Checksum field, not a separate toggle) plus a recursive "Verify All Files" pass for
  whole-folder verification — see CHANGELOG v1.28.0.
- **✅ COMPLETE v1.27.0 – Low-bandwidth warning** — instead of auto-pausing, show a warning banner (e.g.
  "Your bandwidth is low, transfer speeds will be affected") when throughput drops
  or retries spike, so the user knows what's happening without the transfer stalling
  on its own.

## Transfers

- **Search in Transfers** - Ability to search through active transfers to find a specific file. _(Raised 2026-09-09.)_
- **Remove Transfers from Queue** - When you click the `X` next to a queued transfer, nothing happens. This needs to remove that item from the transfer queue so it does not get transfered. _(Raised 2026-09-09.)_
- **Reorder the Queue** - You can rearrange (drag and drop) files to order them in the transfer queue. _(Raised 2026-09-09.)_
- **Pause/Resume transfers** — let the user pause a queued or in-progress transfer
  and resume it later from where it left off, instead of only being able to cancel.
  The underlying piece already exists: `engine.ts`'s `retryItem()` detects a partial
  destination file and passes a `resumeFromOffset` into `createReadStream`/`writeFile`
  to continue rather than restart. Pausing needs its own item status (distinct from
  `canceled`) so a paused item stays in the queue and can be resumed with one click,
  plus pause/resume controls in `TransferPanel.tsx`.
  _(Raised 2026-09-08.)_
- **Resumable transfers across app crashes/quits** — the existing resume-from-offset
  behavior only kicks in when a transfer reaches `error` or `canceled` status and the
  user hits Retry. If Conduit itself crashes or is quit mid-transfer, the queue is
  gone entirely on relaunch. Idea: periodically persist in-flight queue state to disk,
  and on launch detect any partial destination file left from an unfinished transfer
  and offer to resume it.
  _(Raised 2026-09-08.)_
- **Failed-file retry queue** — after a batch transfer finishes with some errors,
  add a one-click "Retry failed" that re-queues only the failed items instead of the
  whole batch.
  _(Raised 2026-09-08.)_
- **Checksum manifest export** — write a `.md5`/`.sha256` sidecar file after a
  "Verify All Files" pass, so the verification result is a document the user can hand
  off as proof of integrity (e.g. before wiping a crew drive) instead of a pass/fail
  shown only in the app.
  _(Raised 2026-09-08.)_
- **Mirror / dual-destination transfer** — send one source to two destinations at
  once (e.g. local backup + Wasabi), for dailies-style workflows where redundancy
  matters as much as getting the file to Wasabi.
  _(Raised 2026-09-08.)_
- **Transfer completion notifications (Slack/email)** — notify when a long,
  unattended transfer (e.g. a full camera card upload) finishes or fails, so no one
  has to babysit the app.
  _(Raised 2026-09-08.)_

## Explorer view

- **✅ COMPLETE v1.29.0 – Resizable columns** — drag column borders in `FileList.tsx` to resize, likely
  persisted per-pane or globally similar to pane widths. Shipped with a Name-column
  floor width (still flexes to fill extra space), double-click-to-fit-content, and
  spreadsheet-style gridlines/hover to match.
- **Color-coded files/folders** — right-click → color label, tints the whole row for
  quick visual scanning (like Finder tags). Local-only for now (stored per-machine,
  not synced to the connection/provider).
- **Colored folders (read native Finder tags)** — read a file/folder's actual macOS
  color tag (macOS Tahoe only) and tint the row to match, instead of requiring a
  separate Conduit-only label like the item above. Would need to read the tag from
  the filesystem (extended attribute) rather than storing Conduit's own color state.
- **✅ COMPLETE v1.27.0 – Transfer speed graph** — a live throughput graph in the Transfers panel (e.g.
  sparkline of MB/s over the life of the transfer), alongside the existing
  progress/ETA display. Pairs naturally with the adaptive Connection Speed idea above
  — same underlying throughput signal could drive both. Shipped as an inline sparkline
  (aggregate + per-file) that pops out into a standalone, resizable window with a
  smoothed X/Y chart, 1/5/15-minute range selector, and a live per-transfer breakdown.
- **✅ COMPLETE v1.29.0 – Show/hide metadata field toggles** — let users choose which columns/fields
  (size, modified date, kind, etc.) appear in the explorer view, controlled from
  Settings. Shipped with Created date, full Path, and (S3/Wasabi only) Storage
  Class and ETag, plus Select All / Deselect All.
- **✅ COMPLETE v1.29.0 – File type filters** — quick filter bar for common media extensions (BRAW, R3D,
  MOV, WAV) so users can jump to just the footage in a large mixed folder. Shipped
  with a Folders-only filter alongside the extension chips.
- **Transfer presets** — save a source→destination pairing with settings (e.g.
  "Camera card → Wasabi archive") as a one-click preset.
- **✅ COMPLETE v1.29.0 – More keyboard shortcuts** — Find (search/jump within the file list), Refresh,
  New Folder, New File, etc., beyond what's already listed under Keyboard Shortcuts
  in Help & Docs (Space, F2, ⌘A, ⌘C, ⌘V, ⌘+/-, ⌘0). Shipped: ⌘↑, ⌘F, ⌘R, ⌘⇧N, ⌘N,
  ⌘P, ⌘`, ⌘L, ⌘W, ⌘D, ⌘I, ⌘⇧C.

## Providers

- **Cloud storage providers (Dropbox, Google Drive, OneDrive)** — take these three
  the rest of the way to production. Provider implementations
  (`src/main/providers/{dropbox,gdrive,onedrive}.ts`), OAuth flows, and connection
  form tabs (`ConnectionModal.tsx`) already exist and are wired into the provider
  factory, but each is still labeled "Not Connected. Coming Soon..." in the connection
  picker — needs real end-to-end testing (auth, token refresh, list/upload/download)
  before flipping that label off and calling it supported.
  _(Revisit for a future update, raised 2026-09-08.)_

## Sharing

- **Download links** — generate a shareable link for a file/folder. Scope: available
  across all providers (Wasabi/S3, Dropbox, OneDrive, Google Drive, etc.), not just
  S3 presigned URLs — each provider's own share/link API where it has one (Dropbox,
  OneDrive, Google Drive all support native shareable links; S3/Wasabi via presigned
  URLs with an expiration). _Work in progress._

## Reporting

- **Transfer history/report export** — a per-project CSV/PDF summary of what was
  transferred, when, and to/from where — useful for studio billing/handoff
  documentation.
