/**
 * Part size Conduit's own S3/Wasabi multipart upload uses (see providers/s3.ts).
 * Shared with the renderer so checksum verification can recompute the same
 * multipart-style hash locally for a file Conduit uploaded — recovering the
 * exact part size from a multipart ETag's encoded part count alone doesn't
 * work in general (the last part is a remainder, not a fixed fraction of the
 * total size), so verification instead relies on this known, fixed value.
 */
export const S3_MULTIPART_PART_SIZE = 32 * 1024 * 1024
