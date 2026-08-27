/** Composite key for per-connection path-keyed caches (folder sizes, stat results,
 *  checksums, item counts). Keying by path alone breaks once two different
 *  connections are in play at once — e.g. Compare across an S3 connection and a
 *  local drive — since a lookup/fetch for one connection could overwrite or be
 *  read back as another's. Including the connectionId keeps each connection's
 *  cached values independent. */
export function connPathKey(connectionId: string, path: string): string {
  return `${connectionId}:${path}`
}
