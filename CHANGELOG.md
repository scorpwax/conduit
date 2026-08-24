# Changelog

All notable changes to Conduit are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/), and Conduit
uses [Semantic Versioning](https://semver.org/): **MAJOR.MINOR.PATCH**
- **MAJOR** — big or breaking changes
- **MINOR** — new features, backwards-compatible
- **PATCH** — bug fixes and small tweaks

## [Unreleased]

_Work in progress lands here, then moves under a version heading on release._

## [1.26.0] — 2026-08-25

### Added
- **Connection Speed info modal** — an "i" icon next to Connection Speed in Settings opens a modal explaining what each preset actually controls, the trade-offs per connection type (S3/Wasabi, SFTP, FTP, local/SMB/NAS), and recommended settings for common scenarios
- **Duplicate now shows progress** — duplicating a file/folder appears in the Transfers panel like every other operation (previously invisible), and the source row shows "name — duplicating…" while it runs
- **Renaming shows progress** — the source row now shows "name — renaming…" while a rename is in flight, matching the delete/duplicate treatment
- **Color-coded transfer status** — the "Process Complete" summary line is now green when everything succeeded, yellow when some items completed and some failed, and red when everything failed or was cancelled (previously always the same color regardless of outcome)

### Changed
- **Renaming now selects the result** — after renaming a file or folder, the newly-renamed item is automatically selected instead of leaving the old selection stale
- A failed duplicate in a multi-item batch no longer silently aborts the rest of the batch (same fix already applied to delete and move)

## [1.25.1] — 2026-08-22

### Fixed
- **macOS build failed in CI** — the universal (x64+arm64) build failed because `ssh2`'s optional native crypto accelerator has no prebuilt arm64 binary, and electron-builder's arch-merge safety check correctly flagged the resulting identical x86_64-only copy on both sides as suspicious. `ssh2` falls back to pure-JS crypto automatically when this module can't load, so it's now explicitly marked as an expected shared file.
- **DMG shipped without the app inside it** — `dmg.contents` had been customized to add a CHANGELOG.md icon but, in doing so, had silently dropped the entry representing the app itself (customizing `contents` replaces electron-builder's default layout entirely rather than extending it). The DMG built and "succeeded" but only contained the background art, the Applications shortcut, and the changelog — no Conduit.app. Restored.

## [1.25.0] — 2026-08-20

### Added
- **Quit confirmation for in-progress transfers** — quitting (Cmd+Q, the app menu, or the tray icon) while a transfer or delete is running now warns you first, separately from the existing active-connections warning
- **Delete progress feedback** — deleting a file or folder now visibly marks the row as "deleting…" instead of giving no feedback until it vanishes; S3/Wasabi folder deletes show real "N / Total objects" progress instead of an indeterminate spinner
- **Crash/hang recovery** — if the renderer ever crashes, the window now auto-reloads instead of staying blank indefinitely; transfers are never interrupted by this since they live in the main process
- **Render error boundary** — an uncaught exception while rendering no longer blanks the whole window; it now shows a "Reload" prompt instead

### Changed
- Bumped Electron 32 → 43
- The transfer summary line now correctly labels deletes and renames instead of calling every in-progress operation "uploading"

### Fixed
- **UI could go blank during very large transfers while the transfer kept running** — the transfer panel rendered one row per queued/transferring file with no cap. A batch of tens of thousands of files (common for image sequences or multi-track audio) could freeze or crash the renderer under that many DOM rows, while the transfer engine — which runs independently in the main process — kept working unaffected. The panel now caps rendered rows (always showing everything actively transferring, capping the queued tail) and shows a "+N more queued" summary instead.
- **S3/Wasabi folder delete could skip objects** — same root cause already fixed for rename in v1.24.2: deleting objects while still paginating the listing shifts S3's continuation token and silently skips some. Delete now collects every key first, then deletes.
- **Dragging/moving a folder onto itself crashed the move handler** — now rejected cleanly instead of attempting an invalid OS-level rename
- **Cmd+Q and the app-menu Quit bypassed the new quit-confirmation** — `before-quit` was marking the quit as already-confirmed before the confirmation dialog ever ran
- **"Connection Speed" default was silently 2 (Slow)** instead of the documented default of 5 (Balanced) for fresh installs

## [1.24.2] — 2026-08-18

### Fixed
- **S3/Wasabi folder rename leaves objects behind** — renaming a folder with many objects would skip some files because the code was deleting objects while still paginating the listing; S3 continuation tokens are position-based and shift when keys are deleted mid-scan. Now all keys are collected first, then everything is copied to the new name, then everything old is deleted.

## [1.24.1] — 2026-08-13

### Fixed
- **Compare: Wasabi size/modified not loading** — the Compare modal now reads size and modified date from the stat result when the listing entry doesn't have them (common with some Wasabi objects); shows "Loading…" while waiting instead of "—"
- **Compare: "+ Add item" closed immediately** — clicking "+ Add item" no longer instantly closes the folder browser; browse to a folder and click "Add to Compare", or click any file, to add it
- **macOS permission popups** — added entitlements and usage description strings so macOS remembers file access grants across launches (Documents, Desktop, Downloads, external drives, network volumes)

## [1.24.0] — 2026-08-13

### Added
- **Rich connection picker in Sync Tasks** — the connection dropdowns in the Sync Task editor now match the main app: shows Favorites, all saved connections, and a "New Connection…" option to create one inline without leaving the sync form
- **Files visible in Sync folder browser** — the folder browser inside Sync Task setup now shows files alongside folders so you can see exactly what's in a directory before selecting it
- **Coffee Maker connection** — a surprise entry in the connection menu for the office espresso aficionado; reports connection latency of 3,000ms (grinding) and a throughput of 1 cup/session

### Changed
- **Sync execute is now non-blocking** — clicking Execute in the sync preview immediately closes the modal and routes progress to the Transfer panel; the rest of the app stays fully interactive while the sync runs
- **Sync panel closes on execute** — executing a sync automatically closes the Sync panel and opens the Transfer panel so you can watch progress without extra clicks
- **Root path auto-populates** — selecting a connection in the Sync Task editor now pre-fills the path field with that connection's configured root path

### Improved
- **Transfer panel redesigned as accordion** — the panel now has two independent collapsible drawers: **Transfers** and **Syncs**, each with their own header, empty state, and actions (Cancel All / Clear)
- **Overall progress strip always visible** — the speed, route, and progress bar stay visible outside the drawers regardless of which drawer is open or collapsed
- **Drawer state persisted across sessions** — the open/closed state of each drawer and the panel height are saved on quit and restored on next launch (both default to closed on first run)

## [1.23.0] — 2026-08-13

### Changed
- **Sync runs non-blocking** — clicking Execute in the sync preview immediately closes the modal and tracks progress in the Transfers panel (same as file transfers), keeping the rest of the app fully interactive while a sync is running
- **Sync cancel works** — the ✕ button on a running sync row in the Transfers panel now correctly stops the sync engine mid-run
- **Elapsed & estimated remaining time** — running sync rows show elapsed time and, once enough files have been processed, an estimated time remaining

## [1.22.0] — 2026-08-07

### Added
- **In-app documentation** — "Help & Docs" tab in Settings covers Getting Started, connection types, file operations, sync tasks, keyboard shortcuts, and the activity log
- **Rename conflict detection** — renaming a file/folder to a name that already exists shows a popup with Overwrite, Merge (folder-to-folder), Rename Again, or Cancel
- **Duplicate files/folders** — new "Duplicate" option in the right-click context menu creates a copy in the same directory (e.g. `file (copy).txt`, `file (copy 2).txt`); supports both files and folders

## [1.21.0] — 2026-08-06

### Added
- **File Sync** — full GoodSync-style sync engine accessible via the new "Sync Tasks" panel in the toolbar
  - **Four sync modes**: Mirror (one-way, propagate deletions), One-Way Copy (left → right, never delete), Two-Way Sync (both directions, newer wins), Two-Way Merge (both directions, never delete)
  - **Conflict resolution**: Newer wins, Larger wins, Keep both (renames left copy with `_left` suffix), or Ask (skips during unattended runs)
  - **Sync database**: three-way diff (left vs. right vs. last-known state) stored per-task in `userData/sync-db/{taskId}.json` — detects independent changes on both sides
  - **Preview before execute**: full file list with SOURCE → action → DESTINATION layout; per-file exclude, direction flip (two-way), and conflict resolution overrides
  - **Scheduled sync**: interval, daily, weekly, monthly, on-launch, or on-connection triggers; runs in the background with system notifications on completion
  - **System tray**: background sync indicator; click to restore window
  - **Launch at startup** toggle for scheduled tasks (macOS and Windows)
  - **Hidden file filter**: "Include hidden files" toggle per task (default OFF — skips dotfiles and hidden directories)
  - **All providers supported**: local, S3/Wasabi, SFTP, SMB, FTP, WebDAV, Google Drive, OneDrive, Dropbox
  - Smart one-way scan: Copy/Mirror modes only list the source directory and stat destination paths individually, avoiding full scans of large destination folders
  - **Include root folder** toggle per sync task — when enabled, files are placed inside a subfolder named after the source directory rather than directly at the destination root
- **Settings panel** — new gear icon in the toolbar opens a dedicated settings modal
  - Transfer concurrency with speed presets (Slow/Balanced/Fast/Custom)
  - Default download folder picker
  - Quit after transfers complete and auto-clear finished transfers toggles
  - Show hidden files toggle
  - Light/Dark theme toggle
  - Launch at startup
- **Enhanced activity log**
  - Split date and time columns for easier scanning
  - Color-coded category badges (Transfer, Sync, Connection, File System, App)
  - Category filter chips
  - Route/location column showing source → destination connection names
  - Transfer speed reporting (e.g. `@ 34.2 MB/s`) and duration
  - Horizontal scroll instead of truncation — full log lines always visible
- **Auto-update notifications** — Conduit checks GitHub Releases on launch and shows a dismissible banner with a direct download link when a newer version is available (platform-correct installer: DMG on macOS, EXE on Windows)

## [1.20.1] — 2026-08-05

### Fixed
- Fixed issue that was causing Conduit to crash on minimization

## [1.20.0] — 2026-08-03

### Added
- **Batch Rename** — new right-click menu item "Batch Rename…" opens a modal with five rename operations:
  - **Replace** — find and replace text within filenames, with optional case-sensitive matching
  - **Add Text** — prefix or suffix text with configurable separator (none / space / dash / underscore)
  - **Remove** — remove specific characters, or strip the first/last N characters from a filename
  - **Sequence** — number files with a configurable sequence name, digit count, starting number, and location (replace / prepend / append); sort order: custom selection, alphabetical, or file date (ascending/descending)
  - **Date** — insert a date (any date or today's date) with format options (YYYY-MM-DD, YYYYMMDD, MM-DD-YYYY, MMDDYYYY, DD-MM-YYYY, DDMMYYYY) at any location with a configurable separator
- Live before/after preview table updates in real time as you adjust settings; conflicting filenames are highlighted in red and automatically skipped with a warning count
- Works on all connection types (local, S3, SFTP, FTP, WebDAV, Google Drive, OneDrive, Dropbox)
- File extensions are always preserved; only the base filename is modified

## [1.19.3] — 2026-07-31

### Changed
- **Context menu** — rearranged into four logical groups separated by dividers:
  1. Open / Quick Look / Open in New Pane / Reveal in Finder / Add to Favorites
  2. Select All / Deselect All / Copy / Paste / Rename…
  3. Download… / Copy Path / Properties / File Tree…
  4. Delete (isolated at bottom)

## [1.19.2] — 2026-07-31

### Fixed
- **Properties Item Count** — now recursively counts all files and folders at every depth inside the selected folder, matching macOS / Windows Get Info behavior. Displays as "387 Items · 300 Files · 87 Folders".

## [1.19.1] — 2026-07-31

### Added
- **Light / Dark mode toggle** — sun/moon button in the top nav switches between themes; preference is persisted across restarts.
- **Properties: byte-exact size** — Size now shows both human-readable and exact byte count (e.g. "269 GB (289,691,237,338 bytes)") for files and folders.
- **Properties: File Count** — folders now show a "File Count" row with total items (files + folders combined), matching the File Tree format.

### Fixed
- **Wasabi S3 chunk-size error (revised)** — previous fix (requestStreamBufferSize) was insufficient; the small-file PutObject path now buffers the stream into a Buffer before uploading, eliminating chunked transfer encoding entirely.

## [1.19.0] — 2026-07-31

### Added
- **Open with default app** — double-clicking a file on a local or SMB connection now opens it in its default app (same as double-clicking in Finder). Also available via right-click → Open.
- **Arrow key expand/collapse for multi-selection** — Right Arrow expands all selected folders' disclosure triangles; Left Arrow collapses them. Works for any number of selected folders, matching Finder behavior.

### Fixed
- **Context menu clipping** — menus that would appear below or to the right of the window edge are now clamped to stay fully visible.
- **Transfer route shown during active transfer** — the "Source → Destination" route label now appears while a transfer is in progress, not only after it completes.
- **Transfer speed** — default concurrency raised from 2 → 4 simultaneous files; local provider now uses `fs.copyFile` (OS-level copy, APFS clone on same volume) and 1 MB stream buffers instead of the default 64 KB.
- **Wasabi S3 chunk size error** — added `requestStreamBufferSize: 256 KB` to the S3 client to prevent "Only the last chunk is allowed to have a size less than 8192 bytes" errors on rearrange/rename operations.
- **Frame.io download URL** — when a file's `original` download URL is temporarily absent (still processing), Conduit now retries once after 3 s before failing with a clearer error message.
- **Pre-existing TypeScript error** in Pane.tsx (`string | null` passed to `folderSize`).

## [1.18.3] — 2026-07-29

### Fixed
- **Frame.io folder sizes** — fixed two bugs that caused folder size calculation to silently fail: workspace-level nodes were using the wrong ID type, and project nodes without a cached `rootFolderId` fell back to the project ID (also wrong). Both now resolve correctly before walking the folder tree.

## [1.18.2] — 2026-07-29

### Added
- **Frame.io folder sizes** — "Calculate All Sizes" and clicking individual folder size cells now works for Frame.io connections. Sizes are computed by recursively walking the Frame.io API (5 folders fetched in parallel per level) and summing `file_size` across all descendants.

## [1.18.1] — 2026-07-29

### Changed
- **Frame.io upload: sliding-window pipeline** — chunks are now uploaded in parallel as they are read from disk (up to 8 concurrent PUTs), rather than buffering the entire file to memory first and then uploading in batches. This eliminates the extra delay before progress begins on large files and maintains ~30 MB/s+ throughput with lower memory usage.

## [1.18.0] — 2026-07-29

### Added
- **Reveal in Finder** — right-click any file in a local pane to reveal it in Finder (macOS). Completed downloads in the Transfer panel also show a folder icon button to reveal the file immediately after transfer.
- **File Tree export** — "Export as .txt" in the File Tree view now saves as `File Tree YYYY-MM-DD.txt` instead of the activity log name.

### Fixed
- **Frame.io duplicate workspaces** — accounts with multiple workspaces sharing the same name now display as "Name", "Name (2)", etc. instead of colliding in the cache and navigating to the wrong workspace.
- **Transfer speed display** — aggregate speed in the Transfer panel header now shows reliably during all transfers using a renderer-side sample buffer, with per-file speed as a fallback.

### Changed
- **Frame.io icon & color** — updated to the official signal/broadcast waves logo on a `#5A52FF` background.
- **Connection menu** — removed Drives and Favorite Folders sections; menu now shows New Connection, Favorites, Active Connections, and Import Connection.

## [1.17.0] — 2026-07-29

### Added
- **Frame.io integration** — connect to Adobe Frame.io V4 as a full pane in Conduit. Sign in with any Adobe ID via OAuth (no credentials to enter — the app handles the flow). Browse workspaces, projects, and folders; transfer files to and from Frame.io and any other connection (local, Wasabi S3, external drives, etc.). Supports upload, download, mkdir, rename, and delete.

## [1.16.0] — 2026-07-23

### Added
- **Resumable downloads** — when a download fails or is canceled partway through, clicking Retry detects the partial file on disk and resumes from that byte offset using an S3 `Range` request instead of restarting from scratch. A 90 GB file interrupted at 70 GB picks up at 70 GB.

### Changed
- **File sizes now match Finder** — all byte displays now use decimal units (1 KB = 1,000 B, 1 MB = 1,000,000 B) instead of binary (1 GiB = 1,073,741,824 B). A 128 GB BRAW file now shows as ~128 GB to match macOS Finder, Finder's Get Info, and most media tools.
- **Default concurrency reduced to 2** — fewer simultaneous transfers means each file gets more bandwidth and is less likely to fail on congested or long-distance connections. Concurrency dropdown now shows descriptive notes for each option so users can make an informed choice.
- **Reverted parallel range-request download** — the 4-simultaneous-GET approach added extra failure points for 40-minute downloads on imperfect connections. Single-stream downloads are more reliable for large BRAW/MXF files over extended transfers.
- **Upload concurrency kept at 6 × 32 MB parts** (192 MB in-flight per file) — the per-file multipart upload improvements from v1.15.0 are retained; the `@aws-sdk/lib-storage` class already retries individual failed parts automatically.

## [1.15.0] — 2026-07-21

### Added
- **"Process Complete" summary** — the completion line in the Transfers header now shows exactly what finished: "√ Process Complete · 5 Files Transferred · 2 Files Downloaded · 3 Renamed · 1 Deleted" — every action type that occurred in the session is listed. Downloads (remote → local), renames, and deletes each appear as their own count.
- **Transfer panel auto-opens** — starting any transfer (drag, download, copy/paste) now automatically expands the Transfers panel so activity is always visible without having to click.

### Fixed
- **"Transfers Cancelled" after Cancel All** — clicking Cancel All now reliably shows "✕ Transfers Cancelled" even if a few files managed to complete before the cancellation landed. Previously, any done item would flip the summary back to "Transfers Complete".
- **Dock badge flickering** — the macOS dock badge was briefly showing the wrong count (e.g. flipping between 1 and 5) because each individual file-completion event was temporarily reporting as "all done". Fixed by computing the badge from the full queue rather than the single item that triggered the event.
- **EGL terminal noise** — suppressed `[ERROR:gl_display.cc] eglQueryDeviceAttribEXT: Bad attribute` log spam that appeared in the terminal when running `npm run dev` on macOS. Tells Chromium to use Metal instead of probing EGL.

## [1.14.0] — 2026-07-21

### Changed
- **Download folder button moved to titlebar** — the download-folder selector is now a button in the top nav bar (↓ FolderName / ↓ Set Downloads) so it's always visible, instead of being buried in the Activity Log footer.
- **Titlebar styling tweaks** — Download folder and Add Pane buttons have a distinct dark background; font control buttons use square corners for a tighter look; icon button font size increased slightly.

## [1.13.0] — 2026-07-21

### Added
- **Drag files out to Finder / Desktop** — files in a local or SMB pane can now be dragged out of Conduit onto the Desktop, Finder windows, or other apps. Uses Electron's native `startDrag` API so macOS receives a real file rather than a text clipping. Remote panes (S3, SFTP, etc.) still use cross-pane drag only.
- **Download context menu item** — right-click any file or folder → "Download…" to transfer it to a user-defined local folder. The first time, a folder picker opens to set the default download location; subsequent downloads go there automatically. The download folder can also be changed any time in the Activity Log settings footer.
- **Retry button for failed transfers** — failed transfer rows now show a ↺ button that re-queues the same transfer immediately without having to drag the file again.

## [1.12.0] — 2026-07-21

### Added
- **Connection-lost banner** — when wifi or network drops mid-transfer, an amber banner appears in the transfer panel: "Connection lost — transfers paused and will resume when you're reconnected." Dismisses automatically when connectivity is restored.
- **Calculate all sizes button** — a "Calculate all sizes" button appears centered in each pane's status bar when there are folders whose sizes haven't been calculated yet. One click queues all of them at once instead of having to click folder-by-folder.

### Fixed
- **Cancel All is now instant** — the transfer engine now stores a reference to the active read stream for each in-flight transfer and destroys it immediately when cancel is called, instead of waiting for the next progress callback (which could be stalled).
- **"Transfers Cancelled" summary** — after cancelling all transfers, the panel now shows "✕ Transfers Cancelled" instead of "✓ Transfers Complete".

## [1.11.1] — 2026-07-20

### Fixed
- **S3/Wasabi upload error** — "Invalid value undefined for x-amz-decoded-content-length" when uploading a file whose size was zero or stale at enqueue time. The engine now always uses the size returned by `createReadStream` (which re-stats the file at transfer start) rather than the size captured during directory enumeration.

## [1.11.0] — 2026-07-20

### Added
- **File Tree** — right-click any folder → "File Tree…" opens a modal showing the full recursive tree with ASCII art connectors (├──/└──/│). Displays file sizes and modified dates inline. Scrollable; loads in the background with a spinner for remote folders. Truncates at 25,000 items with a visible warning. "Export as .txt" saves a plain-text copy of the tree via the system save dialog.

## [1.10.0] — 2026-07-19

### Added
- **macOS notifications** — Electron `Notification` fires when a transfer batch finishes. Shows e.g. "12 completed, 1 failed" in the notification body.
- **Transfer panel summary** — header now reads "✓ 12 completed · 1 failed" (failed count in amber) instead of the generic "Transfers Complete" when a batch finishes.
- **App state persistence** — window size/position and transfer panel open/closed state are saved to `conduit-ui-state.json` on quit and restored on next launch. Number of panes is also restored. Active connections are NOT restored (all connections disconnect on quit as before).
- **Quit confirmation for active connections** — if remote connections are live when quitting, a native dialog warns "You have N active connections. Quitting will disconnect all of them." Includes a "Don't ask again" checkbox that persists the preference.

## [1.9.2] — 2026-07-19

### Added
- **Folder Modified date in file list** — once a folder's size has been calculated, its most-recently-modified child date also populates the Modified column (previously always "—" for S3/Wasabi folders).
- **"Calculating size…" status bar message** — a centered italic label appears in the pane status bar while any folder size walk is in progress, disappearing automatically when done.

## [1.9.1] — 2026-07-19

### Fixed
- **Folder size in Properties** — S3/Wasabi folders now calculate total size via recursive `ListObjectsV2` instead of returning "Unavailable" (which only worked for local drives).
- **Folder modified date in Properties** — S3/Wasabi folders now show the most recently modified object's date, since S3 has no native directory metadata.
- `folderSize` IPC return type expanded to `{ size, latestModified }` so both values come back in one call.

## [1.9.0] — 2026-07-19

### Added
- **Properties panel** — renamed from "Get Info"; now shows full details for both files and folders.
- **Folder size & modified in Properties** — folders now display their size (click to calculate) and last-modified date alongside files.
- **Folder contents count** — Properties on a folder shows how many files and subfolders are directly inside it (e.g. "3 folders, 12 files").
- **Path character count** — the Path row now shows the character count inline. Paths exceeding 256 characters display an amber warning, surfacing the Windows path-length limit.
- **Checksum shown for files only** — folder rows no longer show a meaningless checksum field.

## [1.8.9] — 2026-07-17

### Added
- **Windows support** — Conduit now builds and runs on Windows 10/11. NSIS installer produced by GitHub Actions CI on every push to main.
- **GitHub Actions build workflow** — `.github/workflows/build.yml` builds a macOS DMG and a Windows installer in parallel on every push to `main`, and on-demand via the Actions tab. Artifacts are downloadable directly from GitHub.

### Fixed (Windows compatibility)
- macOS traffic-light titlebar spacer is now hidden on Windows (was always visible, wasting 62px of toolbar space)
- Quick Look (spacebar preview) is now macOS-only — hidden from the context menu and keyboard handler on Windows
- "Reveal in Finder" and "Mount to Desktop" are now hidden on Windows (macFUSE / rclone mount is macOS-only)
- Folder size calculation now uses a pure-Node recursive stat walk on Windows instead of `du -sk` (Unix-only)
- rclone S3 mount and unmount are guarded against Windows (clear error message instead of silent crash)

## [1.8.8] — 2026-07-16

### Added
- **Export connection profile** — each saved connection in the connection picker now has a ↓ export button alongside the star/edit/delete icons. Clicking it opens the native save dialog and writes a `.conduit` profile file, the same format accepted by "Import Connection…". Previously export was only reachable by right-clicking a connection.

### Fixed
- **"Choose Connection" → New Connection form** — the empty-pane placeholder button now opens the New Connection form directly instead of the connection picker dropdown.

## [1.8.7] — 2026-07-16

### Added
- **Get Info — Web URL** — S3 and Wasabi files now show their public HTTPS URL (e.g. `https://studios-production.s3.us-west-2.wasabisys.com/00_UNSORTED/file.braw`). Uses virtual-hosted style, derived from the connection's bucket + endpoint/region.
- **Get Info — Checksum** — files on S3/Wasabi show their ETag (MD5 for simple uploads). Fetched live from `HeadObject` so it always reflects what's on the server.
- **Get Info — File Type** — shows the human-readable type label (same as the Type column in the file list, e.g. "BRAW Video", "WAV Audio").
- **Get Info — click any row to copy** — clicking any row in the Get Info panel copies its value to the clipboard and briefly shows "Copied!".
- **Breadcrumb → Copy Path** — right-clicking any breadcrumb segment now offers "Copy Path" in addition to "Open in New Pane" and "Add to Favorites".

### Fixed
- **Rename fails on files >5 GB** — S3's `CopyObject` API rejects files over 5 GB with "copy source is larger than the maximum allowable size". Rename now automatically uses multipart copy (`UploadPartCopy`) for large files (128 MB parts), with a clean abort on failure. This fixes renaming large BRAW/R3D/MOV camera originals on Wasabi.

## [1.8.6] — 2026-07-16

### Added
- **Get Info** (right-click menu) — opens a panel showing all available metadata for the file or folder: name, kind, full path, size, and last-modified date. Size and modified date are re-fetched live from the connection so values are always accurate.
- **Copy Path** (right-click menu) — copies the full path of the file or folder to the clipboard (e.g. `/studios-productions/00_UNSORTED/file.wav`). A small toast notification confirms the copy.
- **Transfer size verification** — after every successful file transfer, Conduit stats the destination to confirm the written size matches the source size. A warning is logged if they differ, making silent corruption or truncation visible in the Activity Log.

### Fixed
- **Log Export now respects current filters** — Export only writes the entries currently visible (filtered by level, date range, and search query), not the full raw log. The count shown in the footer matches exactly what gets exported.

## [1.8.5] — 2026-07-15

### Added
- **Drop files onto folders** — files can now be dragged and dropped directly onto a folder row in any pane, just like Finder. Works for cross-pane drags (e.g. local → a specific Wasabi subfolder), same-pane drags (reorganize files within the same connection), and native OS drags from Finder or the desktop. When hovering over a folder target the folder highlights and the pane no longer also highlights, so it's clear exactly where the files will land.

## [1.8.4] — 2026-07-15

### Fixed
- **Wasabi multipart upload Deserialization error** — `CreateMultipartUpload` and `CompleteMultipartUpload` were still throwing `Invalid RFC7231 date-time value` from Wasabi's non-standard `Expires` header, aborting all large-file transfers before any data was sent. Previous attempts (HTTP-handler subclass, client middleware) were bypassed by the AWS SDK's newer schema-based serde pipeline. The actual fix patches `@smithy/core`'s `_parseRfc7231DateTime` to fall back to RFC3339 parsing (which already handles Wasabi's ISO 8601 format) before throwing — fixing the error at its source. A `postinstall` script re-applies the patch automatically after `npm install` so it survives dependency updates.

## [1.8.3] — 2026-07-15

### Fixed
- **Genuine upload progress for large files** — files over 50 MB now use multipart upload (16 MB parts), so progress advances as each part is confirmed by the server rather than jumping to 100% as soon as bytes are buffered locally. The extended "Waiting for server…" phase after the progress bar fills is now a brief finalisation step (typically a few seconds) rather than several minutes.
- **Root-cause fix for Wasabi Deserialization errors** — previously, Wasabi's non-standard ISO 8601 `Expires` header caused the AWS SDK smithy parser to throw before it could extract the multipart `UploadId`, silently discarding large uploads. The fix intercepts Wasabi's HTTP responses at the transport layer (before deserialization) and strips the `Expires` header. This removes the error at its source rather than swallowing it after the fact, and restores multipart upload compatibility with Wasabi.

## [1.8.2] — 2026-07-15

### Changed
- **Clearer large-file upload feedback** — large files (e.g. 1–4 GB WAV files) go through two distinct phases: the app streams bytes to the network (progress fills 0→100%), then waits for the server's HTTP 200 confirmation (server-side processing). The old "Finalizing…" label made this phase look frozen. It now shows:
  - **Per-row**: "Waiting for server · 2m 15s" with a running elapsed timer, so you can see time is passing
  - **Panel header**: "4 files · 7.9 GB · Waiting for server…" replaces the blank speed field
  - **Progress bar center**: "Waiting for server…" replaces "Finalizing…"
- The elapsed timer on each row starts counting the moment that file enters the server-wait phase, giving an accurate view of how long the server has been processing that specific file.

## [1.8.1] — 2026-07-14

### Fixed
- **Large file uploads to Wasabi now actually land on the server** — files larger than 50 MB were silently dropped. The root cause: the AWS SDK's multipart `Upload` class calls `CreateMultipartUpload` first; Wasabi's response includes an `Expires` header in ISO 8601 format (not RFC 7231), which the SDK's smithy parser rejects with a "Deserialization error" *before a single byte is sent*. The code was swallowing this error, marking the transfer as complete even though nothing was uploaded. Fix: removed the multipart code path entirely. All files now use `PutObjectCommand` (single-request upload) with a Transform stream for byte counting — the same path that was already working for small files. With this approach the file body is the HTTP request payload, so the server receives the data before the SDK parses the response; swallowing the Deserialization error on the 200 OK is safe.
- **Transfer panel auto-clears on new transfer** — starting a new transfer now automatically clears any previously completed/failed transfers from the panel, so you always start with a clean view.

## [1.8.0] — 2026-07-14

### Changed
- **Transfer performance overhaul (Cyberduck-inspired)** — the app now stays fully fluid during large transfers:
  - **Timer-based progress**: I/O threads only update byte counters. A single 250ms timer reads all active items and batches the update to the renderer — exactly the pattern Cyberduck uses. The I/O path never triggers UI work.
  - **Batched `onAdded` IPC**: new-item events are coalesced for 500ms before being sent to the renderer, reducing discovery IPC sends from ~120 down to ~24 for a 6000-file job.
  - **`useMemo` on all O(n) panel computations**: filtering, reducing, and sorting 6000 items now only runs when the `transfers` array actually changes, not on every 250ms timer tick.
  - **`React.memo` on `TransferRow`**: only the 3–5 actively-transferring rows re-render per tick; completed rows are skipped entirely.
  - **App-level transfers subscription removed**: `App.tsx` no longer subscribes to `transfers` state, eliminating a class of full-app re-renders on every progress update.
  - **Pane refresh logic moved to store**: done-transfer detection (which triggers destination pane refresh) now runs inside the store's `onUpdate` handler, not in the App component tree.
- **Configurable transfer concurrency** — default raised from 3 to 5 simultaneous transfers (matching Cyberduck's default). Adjustable in Logs → footer via "Concurrent transfers" selector. Takes effect immediately without restart.

## [1.7.0] — 2026-07-13

### Changed
- **Large-transfer performance** — the app now stays fully responsive during transfers of thousands of files (e.g. 6 000-file / 11+ GB jobs that previously caused lag and crashes):
  - **Progressive directory walk**: `enqueue` returns immediately and discovers files in the background, streaming them to the queue in batches of up to 50. Transfers begin as soon as the first batch is discovered rather than after the entire tree is walked.
  - **Batched IPC updates**: progress events are coalesced for 200 ms before being sent to the renderer, cutting IPC round-trips from ~60/sec down to ≤5/sec regardless of how many files are in-flight.
  - **O(1) store updates**: the renderer now applies batch update arrays via a Map lookup instead of an O(n) array scan on every progress tick.
  - **Capped visible list**: the transfer panel renders at most 100 completed rows plus all active/queued items, instead of all N items. A summary row shows how many older completed transfers are hidden; they clear on "Clear".
  - **Auto-eviction**: completed, canceled, and errored items are removed from engine memory after 90 seconds, preventing unbounded RAM growth during large jobs.

## [1.6.6] — 2026-07-12

### Added
- **Icons in connection dropdown** — the Favorites, Drives, and Connections sections
  of the connection picker now show the same SVG icons used everywhere else, replacing
  the old emoji/text abbreviations (floppy disk, "W", padlock, etc.).
- **Border-top color accent on type cards** — each connection type card in the New
  Connection modal now shows a 3 px colored top border matching its brand color,
  giving a quick visual cue that matches the pane tab accent.
- **Date filtering in Logs** — the Activity Log header now includes "All time / Today /
  7 days / 30 days" filter chips alongside the existing level chips, so you can quickly
  narrow the log to recent activity.

### Fixed
- **OneDrive and Dropbox icons now visible** — both icons were rendering white SVG paths
  on the white brand-card background and were invisible. Paths now use their proper
  brand colors (#0078D4 for OneDrive, #0061FF for Dropbox).

### Changed
- **Transfers panel starts collapsed** — the Transfers panel now opens in its collapsed
  state by default. Click the header to expand it when you want to see per-file detail.

## [1.6.5] — 2026-07-12

### Added
- **Unified connection color palette** — every connection type now has a
  consistent brand color used across the pane tab border, connection picker
  icon, and New Connection modal. Colors: Local (slate grey), Amazon S3
  (amber), Wasabi (green), SFTP (purple), SMB (pink), FTP (red), WebDAV
  (teal — distinct from SMB pink), Google Drive (Google blue), OneDrive
  (Microsoft blue), Dropbox (Dropbox blue).
- **Custom SVG icons for all connection types** — all ten connection types now
  display a proper SVG icon instead of emoji or text abbreviations. Protocol
  types (Local, S3, Wasabi, SFTP, SMB, FTP, WebDAV) use clean monochrome
  icons on their brand-color backgrounds; cloud OAuth providers (Google Drive,
  OneDrive, Dropbox) use their official multi-color logos on white.
- **Type-based pane tab color** — the colored top border on each pane now
  reflects the connection *type* (e.g. all Wasabi connections are green) instead
  of a random hash of the connection ID. Single source of truth: `connMeta.tsx`.

## [1.6.4] — 2026-07-12

### Fixed
- **Duplicate transfers in the panel (root cause fix)** — React `StrictMode`
  intentionally double-invokes effects in development (mount → unmount →
  remount). The `init()` effect had no cleanup, so both runs registered an
  `onAdded` IPC listener, causing every transfer to be added to the store
  twice. Fixed by removing `StrictMode` (it is incompatible with IPC
  subscriptions in Electron) and making `init()` tear down any previous
  listeners before registering new ones, so re-calls are always idempotent.

## [1.6.3] — 2026-07-12

### Fixed
- **Duplicate transfer entries after window reopen** — on macOS, clicking the
  dock icon when the window was closed called `createWindow()` again, which
  stacked a second set of engine event listeners. Every subsequent
  delete/transfer event was then sent twice to the renderer, producing duplicate
  rows in the Transfers panel. Engine listeners are now registered once at module
  scope so re-opening the window never adds extras.

## [1.6.2] — 2026-07-12

### Fixed
- **No more 1-minute hang at 99% for large files** — files larger than 50 MB now
  use S3 multipart upload (16 MB parts). Wasabi acknowledges each part
  independently, so progress advances all the way to completion. A single
  `PutObjectCommand` for a 1.6 GB file made the SDK wait 30–60 s for Wasabi's
  final HTTP 200 after all bytes were sent, causing the frozen-at-99% appearance.
- **"Finalizing…" pulse replaces frozen progress** — when all bytes have been
  sent but the server hasn't responded yet (e.g. the last multipart completion
  call), the progress bar pulses and shows "Finalizing…" instead of a frozen
  percentage, so the user knows the transfer is still active.

## [1.6.1] — 2026-07-12

### Fixed
- **Transfer progress no longer freezes** — the S3/Wasabi upload buffer was 8 MB,
  causing a fast burst of progress callbacks as the local SSD filled the buffer,
  then complete silence while the network slowly drained it. Buffer reduced to
  256 KB so callbacks fire at network speed, giving smooth, continuous progress.
- **Time Remaining now appears** — remaining time now uses the engine's live speed
  estimate (updated every 50 ms) instead of the panel-level 1-second sampler, and
  the warmup before showing an estimate is reduced from 5 s to 2 s.
- **Elapsed and remaining update 4× more often** — the display clock now ticks
  every 250 ms instead of every 1 s, so the counters feel live rather than
  updating in coarse 1-second jumps.

## [1.6.0] — 2026-07-12

### Added
- **Real brand icons in the connection picker** — Google Drive, OneDrive, and
  Dropbox now show their actual logo SVGs instead of text abbreviations ("GD",
  "1D", "DB").
- **Finder-style keyboard navigation** — Return key renames the selected item;
  ⌘↓ navigates into a folder; ↑/↓ arrow keys move the selection; ←/→ arrow
  keys collapse / expand disclosure triangles on folders.
- **Drag count badge** — when dragging more than one item, a small blue pill
  shows "N items" near the cursor so you always know how many files are in
  flight.

### Fixed
- **Elapsed time freezes when transfers complete** — the counter now locks at
  the moment the last transfer finishes instead of continuing to count up
  indefinitely.
- **Remaining time accuracy** — remaining time is now computed from panel-level
  byte-sample deltas (one sample per second) rather than the engine's
  Transform-level speed, which was inflated by local disk read-ahead. The
  5-second warm-up before showing any estimate is preserved.
- **Overall progress visible while collapsed** — the progress bar, elapsed
  time, and remaining time stay visible when the Transfers panel is collapsed.
  Only the per-file list is hidden by the collapse.
- **Single log file with date separators** — logs are now appended to one
  `conduit.log` file instead of a new file each day. A separator banner like
  `======= SUNDAY, JULY 12TH, 2026 =======` is inserted whenever the date
  changes, making it easy to scan across sessions.
- **Item count shows only visible files** — the pane footer now counts only
  non-hidden items when "show hidden files" is off, matching what you actually
  see in the list.
- **Click empty space to deselect** — clicking anywhere in the file list that
  is not a file row now clears the selection, matching Finder behavior.

## [1.5.7] — 2026-07-09

### Fixed
- **No more duplicate delete/rename entries** — each operation now carries a
  dedup key (the full path). A second delete or rename for the same path while
  the first is still visible in the panel is silently skipped.
- **Progress bar now shows elapsed · % · remaining in correct positions** — the
  three labels are always rendered so `space-between` keeps the percentage
  pinned in the center rather than drifting when the remaining estimate is
  hidden.
- **Clear button works instantly** — the store now clears finished transfers
  optimistically (before the IPC round-trip) so the list empties the moment you
  click. The IPC call still fires in the background to clean up the engine.
- **Clear button no longer collapses the panel** — the header is split into a
  dedicated clickable toggle zone (chevron + title + count) and a separate
  actions zone (Cancel all / Clear). Buttons in the actions zone can never
  accidentally trigger the collapse.

## [1.5.6] — 2026-07-09

### Fixed
- **No more ~0s remaining** — speed was being measured against local disk read
  rate (SSD reads at 1-3 GB/s) instead of actual Wasabi upload throughput. Speed
  now uses a 5-second sliding window so it reflects real network throughput, and
  the remaining estimate is hidden for the first 5 seconds to suppress noisy
  early readings.
- **Eliminated remaining duplicates** — dedup now blocks re-queuing any file
  whose destination path is already present in the queue at any status (queued,
  transferring, or done), not just active ones. Clear finished items if you want
  to intentionally re-upload the same file.
- **3-5 second startup delay cut significantly** — conflict checks now run all
  `dest.exists()` calls in parallel instead of sequentially (was 9 × ~400ms =
  3-4s; now ~400ms). Stat calls inside enqueue also run in parallel.
- **TLS connections reused across transfers** — S3/Wasabi provider now uses a
  persistent HTTPS agent (`keepAlive: true`), so the cold-start TLS handshake
  only happens once per provider session rather than on every file.
- **Header shows "uploading · queued" counts separately** — e.g. "3 uploading ·
  6 queued · 2.1 GB / 9.8 GB · 120 MB/s" so you can see how many slots are busy
  vs. waiting.
- **Queued items show "—" not "0%"** — items waiting for a concurrency slot no
  longer show a confusing "0%" in the speed column; they show a dash instead.

## [1.5.5] — 2026-07-09

### Fixed
- **No more duplicate transfer entries** — re-queuing files that are already
  queued or actively transferring to the same destination path is now silently
  skipped, so the list stays clean after retries.
- **"Transfers Complete" shown when all done** — the transfer panel header now
  shows a green "✓ Transfers Complete" label (with a failed count if any errored)
  once all items finish, replacing the generic "16 done" text.
- **Progress bar stays visible after completion** — the overall progress bar and
  elapsed time remain visible at 100% after all files finish, so you can see how
  long the transfer took.
- **Elapsed time now spans the full session** — previously it measured from the
  earliest *currently-active* item's start time, so it reset when items finished.
  Now it anchors to the earliest start across all items.
- **Delete and rename show in Transfers** — deleting files/folders and renaming
  items now appear as operation entries in the transfer panel (spinner while
  running, checkmark on success, ✕ on error), so every mutation is visible in
  one place.

## [1.5.4] — 2026-07-09

### Fixed
- **App no longer crashes mid-transfer when the window closes** — progress
  callbacks fired from the S3 upload stream could throw "Render frame was
  disposed before WebFrameMain could be accessed" when the window was being torn
  down. `sendToRenderer` now wraps the IPC send in a try/catch, and the
  Transform's progress callback does the same, so stream errors can't propagate
  up to crash the upload.
- **Log copy shows "Copied to Clipboard" confirmation** — clicking a log row to
  copy it now flashes a brief "Copied to Clipboard" label in the log panel header
  for 2 seconds, so you know the copy succeeded.

## [1.5.0] — 2026-07-09

### Fixed
- **Subsequent Wasabi/S3 transfers now actually transfer** — the second and later
  transfers to Wasabi were logging SUCCESS but no files were uploaded. Root
  cause: `walk()` called `dest.mkdir()` on every directory even when files
  existed inside it; the `PutObjectCommand` Wasabi sends back throws a
  `Deserialization error` parsing its response, which aborted `enqueue()` before
  any items were queued. Fixed by (a) only calling `mkdir` for truly empty
  directories, and (b) swallowing Wasabi's date-format parse error in `mkdir`
  the same way it was already swallowed in `writeFile`.
- **Transfer pane resizable again** — the panel could not be dragged to a new
  height because the file list was overflowing its bounds. Added `flex: 1;
  min-height: 0` to `.transfer-list` so content is clipped to the dragged size.
- **Overall progress bar now shows true aggregate progress** — bytes from
  completed items were dropped as they finished, causing the percentage to
  stall or regress. The bar now counts all non-canceled/non-errored items so it
  moves steadily forward and reaches 100%.
- **Cancel All requires confirmation** — clicking "Cancel all" now shows the
  same danger-styled confirmation dialog used by Delete, preventing accidental
  cancellations.
- **Status bar shows real folder sizes** — selected folder sizes in the pane
  footer now reflect the calculated disk usage (shown after the auto-fetch
  completes) rather than always reading 0. Folder size state was lifted from
  FileList to Pane so the status bar can access it.
- **Folder sizes auto-fetch in expanded subdirectories** — when you expand a
  folder with the disclosure triangle, any subdirectories inside it now also
  auto-calculate their sizes (previously only top-level dirs were fetched).

## [1.4.0] — 2026-07-08

### Added
- **Mount S3 / Wasabi to Desktop** — right-click an S3 or Wasabi connection in
  the dropdown → Reveal in Finder or Mount to Desktop now works for cloud
  buckets via `rclone` (requires `brew install rclone` and
  `brew install --cask macfuse`). A clear error message is shown if rclone is
  not installed.
- **Folder sizes auto-load** — on local and SMB connections, folder sizes
  populate automatically when you open a directory (shown as `…` while
  calculating). No need to click the dash anymore.

### Fixed
- **SFTP `.local` hostname resolution** — connecting to a Mac by its `.local`
  Bonjour name (e.g. `MS-MWAX-BNI.local`) no longer fails with
  `ENOTFOUND`. Node's DNS is pre-resolved through the OS mDNS stack before
  the SSH library sees it.

## [1.3.0] — 2026-07-08

### Added
- **Select All / Deselect All** — right-click in any pane to select every visible
  item at once, or clear the selection; ⌘A selects all from the keyboard.
- **Folder sizes on demand** — click the `—` in the Size column next to any
  folder to calculate its full disk usage; shows `…` while computing, then the
  real size.
- **Selected size in the status bar** — the pane footer now reads
  "7 Items · 3 selected · 365 MB" when files are selected.
- **Pane color coding** — each connection is assigned a distinct accent color
  from a palette of 8, shown as a 3 px top border on the connection bar.
  Colors are deterministic (same connection always gets the same color) so
  muscle memory builds up naturally.
- **Reveal in Finder** — right-click any local or SMB connection in the
  connection dropdown → Reveal in Finder opens the mount point in the OS.
- **Mount to Desktop** — right-click a local or SMB connection in the dropdown
  → Mount to Desktop creates a symlink on your Desktop pointing at the mount
  root, so the share is one click away from the Finder.

### Fixed
- **Cancel All** now reliably reflects the canceled state in the transfer list
  immediately (adds a full resync after the IPC call).

## [1.2.0] — 2026-07-08

### Added
- **Connection status lights in the dropdown** — a colored dot next to each
  saved connection shows at a glance whether it is connected (green), loading
  (yellow), in error (red), or live in the background (dim green, pane closed
  but still connected).
- **Background connections** — closing a pane no longer disconnects it.
  The connection stays live until you hit the ⏏ Disconnect button or quit the
  app, and its dim green dot in the dropdown confirms it.
- **Overall transfer progress bar** — a full-width bar below the Transfers
  header shows aggregate progress across all active transfers, plus elapsed
  time and an estimated time remaining.
- **Active transfers sort to the top** — the transfer list now shows
  transferring items first, then queued, then done/failed (most recent first).
- **Export connection profile** — right-click any saved connection → Export
  Profile… saves a `.conduit` JSON file (credentials are not included) that
  you can share with a coworker.
- **Import connection profile** — the connection dropdown has an "Import
  Connection…" option that opens a `.conduit` file and pre-fills the New
  Connection form so you only need to enter your own credentials.

## [1.1.0] — 2026-07-07

### Added
- **Inline tree navigation** — disclosure triangles on folders expand their
  contents in place, alongside the breadcrumbs.
- **Drag from the OS** — drop files/folders from Finder/desktop onto a pane:
  an empty pane opens that location; a connected pane uploads to it.
- **Copy & paste** files/folders (right-click or ⌘C/⌘V) — copies via the
  transfer engine, keeping the source.
- **Adjustable font size** — A−/A+ in the toolbar and ⌘+/⌘−/⌘0 (persisted).
- **Right-click on breadcrumbs and connection/drive entries** — Open in New
  Pane, Add to Favorites.

### Changed
- Removed duplicate "Macintosh HD" and hidden system volumes (e.g. .timemachine)
  from the Drives list.

## [1.0.1] — 2026-07-07

### Fixed
- Quitting the app no longer throws a JavaScript error (log/transfer events were
  being sent to the window after it was destroyed during shutdown).

### Changed
- Added `us-west-2` to the region suggestions, and made the Wasabi region field
  free-text (like S3) so any region can be entered.

## [1.0.0] — 2026-07-07

First packaged release.

### Connections
- Local & external drives
- Amazon S3 (and S3-compatible endpoints)
- Wasabi (dedicated, auto-configured S3)
- SFTP / SSH (including computer-to-computer transfers)
- SMB shares (via the OS mount, with Guest/anonymous support)
- FTP / FTPS
- WebDAV (Nextcloud, ownCloud, Box, …)
- Google Drive, OneDrive, Dropbox (OAuth)

### Features
- Dual (up to 5) resizable, reorderable panes with Finder-style browsing
- Drag-and-drop transfers between any two connections
- Live transfer progress panel with speed and cancel
- Overwrite conflict prompt (Replace / Keep Both / Skip)
- Delete, rename, new file/folder with confirmation dialogs
- Right-click menu: Quick Look, Open in New Pane, Add to Favorites, Rename, Delete
- Favorite connections and favorite folders (bookmarks)
- Search/filter, sortable columns (Name / Size / Type / Modified)
- Hidden-files toggle
- Quick Look preview (Space)
- Live activity log with retention settings, export, and search
- Encrypted transports (SFTP, TLS for cloud/S3, FTPS default)
- Connections disconnected cleanly on quit
