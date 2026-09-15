/**
 * Default/minimum part size Conduit's own S3/Wasabi multipart upload uses
 * (see providers/s3.ts) for any file that fits within S3's 10,000-part limit
 * at this size (up to ~312.5 GiB). Shared with the renderer so checksum
 * verification can recompute the same multipart-style hash locally for a
 * file Conduit uploaded — recovering the exact part size from a multipart
 * ETag's encoded part count alone doesn't work in general (the last part is
 * a remainder, not a fixed fraction of the total size), so verification
 * instead recomputes it from the file's size via computeMultipartPartSize
 * below, using this same constant as the floor.
 */
export const S3_MULTIPART_PART_SIZE = 32 * 1024 * 1024

/** S3 (and S3-compatible, e.g. Wasabi) hard limit: a multipart upload can have at most this many parts. */
export const S3_MAX_MULTIPART_PARTS = 10_000

/**
 * The part size to use for a file of the given size, so it never exceeds
 * S3's 10,000-part-per-upload limit. Below ~312.5 GiB (32 MiB × 10,000) this
 * is just the fixed S3_MULTIPART_PART_SIZE default; above that, it scales up
 * (rounded up to a whole MiB) so a single huge file — e.g. an uncompressed
 * MXF/RAW camera clip — still fits within 10,000 parts instead of the
 * upload failing partway through with "Part number must be an integer
 * between 1 and 10000, inclusive."
 *
 * Must be used identically on both the upload side (providers/s3.ts) and
 * the verification side (verify.ts, FileList.tsx's multipart-hash
 * reconciliation) — the whole point is a checksum recomputed locally from
 * the same part boundaries the object was actually uploaded with.
 */
export function computeMultipartPartSize(fileSizeBytes: number, minPartSize: number = S3_MULTIPART_PART_SIZE): number {
  if (fileSizeBytes <= minPartSize * S3_MAX_MULTIPART_PARTS) {
    return minPartSize
  }
  const MIB = 1024 * 1024
  return Math.ceil(fileSizeBytes / S3_MAX_MULTIPART_PARTS / MIB) * MIB
}
