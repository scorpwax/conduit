# Roadmap

Ideas and planned improvements that aren't built yet. Not a commitment or a timeline —
just a place to track what's next so ideas don't get lost between sessions.

Once an item ships, it's marked `COMPLETE vX.Y.Z –` at the front of its bullet (the
version it shipped in) instead of being deleted, so this file also works as a record
of when things landed.

## Settings

- **COMPLETE v1.27.0 – Adaptive Connection Speed** — "Connection Speed" (Settings) currently sets
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
- **COMPLETE v1.28.0 – Checksum verification toggle** — optional MD5/ETag compare on top of the existing
  size-verify, for extra integrity assurance on critical media files (BRAW/R3D/etc.).
  Shipped as multipart-aware checksum verification (built into Compare's existing
  Checksum field, not a separate toggle) plus a recursive "Verify All Files" pass for
  whole-folder verification — see CHANGELOG v1.28.0.
- **COMPLETE v1.27.0 – Low-bandwidth warning** — instead of auto-pausing, show a warning banner (e.g.
  "Your bandwidth is low, transfer speeds will be affected") when throughput drops
  or retries spike, so the user knows what's happening without the transfer stalling
  on its own.

## Explorer view

- **Resizable columns** — drag column borders in `FileList.tsx` to resize, likely
  persisted per-pane or globally similar to pane widths.
- **Color-coded files/folders** — right-click → color label, tints the whole row for
  quick visual scanning (like Finder tags). Local-only for now (stored per-machine,
  not synced to the connection/provider).
- **COMPLETE v1.27.0 – Transfer speed graph** — a live throughput graph in the Transfers panel (e.g.
  sparkline of MB/s over the life of the transfer), alongside the existing
  progress/ETA display. Pairs naturally with the adaptive Connection Speed idea above
  — same underlying throughput signal could drive both. Shipped as an inline sparkline
  (aggregate + per-file) that pops out into a standalone, resizable window with a
  smoothed X/Y chart, 1/5/15-minute range selector, and a live per-transfer breakdown.
- **Show/hide metadata field toggles** — let users choose which columns/fields
  (size, modified date, kind, etc.) appear in the explorer view, controlled from
  Settings. Beyond what's already in the Properties/info modal (Kind, Type, Size,
  Modified, Checksum), consider adding: **Created date**, **full path**, and for
  S3/Wasabi specifically **storage class** and **ETag** (as a lighter alternative to
  the full checksum fetch).
- **File type filters** — quick filter bar for common media extensions (BRAW, R3D,
  MOV, WAV) so users can jump to just the footage in a large mixed folder.
- **Transfer presets** — save a source→destination pairing with settings (e.g.
  "Camera card → Wasabi archive") as a one-click preset.

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
