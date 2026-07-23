import type { Readable } from 'stream'
import type { Connection, FileEntry, ListResult, ConnectionTestResult, FolderTreeResult } from '@shared/types'

/**
 * A Provider abstracts one connection type (local disk, S3, later SFTP/SMB)
 * behind a uniform interface. The transfer engine and IPC layer talk only to
 * this interface, so adding a new backend means implementing one class.
 */
export interface Provider {
  readonly connection: Connection

  /** List the contents of a directory (or the root when path is ''). */
  list(path: string): Promise<ListResult>

  /** Stat a single entry. */
  stat(path: string): Promise<FileEntry>

  /**
   * Open a readable stream for a file. When offset > 0, the stream begins
   * at that byte position (used to resume interrupted downloads).
   * Returned `size` is always the TOTAL file size, not the remaining bytes.
   */
  createReadStream(path: string, offset?: number): Promise<{ stream: Readable; size: number }>

  /**
   * Write a file from a readable stream. Implementations should call
   * onProgress with the cumulative number of bytes written (including
   * appendFromOffset) when possible.
   * When appendFromOffset > 0, the provider appends to an existing file
   * instead of overwriting it (used for resumable downloads).
   */
  writeFile(
    path: string,
    body: Readable,
    size: number,
    onProgress?: (bytesWritten: number) => void,
    appendFromOffset?: number
  ): Promise<void>

  /** Ensure a directory exists (recursively). No-op for object stores. */
  mkdir(path: string): Promise<void>

  /** Create an empty file at path (creating parent dirs as needed). */
  createFile(path: string): Promise<void>

  /** Delete a file or directory (recursive for directories). */
  delete(path: string, kind: 'file' | 'directory'): Promise<void>

  /** Rename an entry in place to newName (basename only, same directory). */
  rename(path: string, newName: string): Promise<void>

  /** True if something exists at path. Used for overwrite/keep-both checks. */
  exists(path: string): Promise<boolean>

  /** Join path segments using this provider's separator semantics. */
  join(...segments: string[]): string

  /** The parent directory of a path, or null at the root. */
  parent(path: string): string | null

  /** Verify the connection is reachable / credentials are valid. */
  test(): Promise<ConnectionTestResult>

  /**
   * For providers backed by a local filesystem path (local drives, SMB mounts),
   * returns the OS path that serves as the connection root. Triggers the mount
   * if needed (e.g. SMB). Returns null for cloud/remote-only providers.
   */
  getLocalRoot?(): Promise<string | null>

  /**
   * Return a checksum for the file at path (e.g. ETag / MD5). Returns null
   * for providers that don't support checksums.
   */
  checksum?(path: string): Promise<string | null>

  /**
   * Return the total byte size of all objects under a folder path, plus the
   * most-recent modification date among them. Null when not supported.
   */
  folderSize?(path: string): Promise<{ size: number; latestModified: string | null } | null>

  /**
   * Build a full recursive file tree for a folder. Providers with efficient
   * bulk-listing (e.g. S3 ListObjectsV2 without delimiter) should implement
   * this; others fall back to the generic recursive list() loop in the IPC handler.
   */
  folderTree?(path: string): Promise<FolderTreeResult>
}
