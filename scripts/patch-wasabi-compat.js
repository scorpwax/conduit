/**
 * Patches @smithy/core's _parseRfc7231DateTime to handle ISO 8601 / RFC 3339
 * timestamps (e.g. "2026-07-22T18:18:46Z") as a fallback before throwing.
 *
 * Some S3-compatible providers (notably Wasabi) return `Expires` as ISO 8601
 * rather than the RFC 7231 format the AWS SDK expects. Without this patch,
 * every S3 API response from Wasabi that includes an Expires header throws
 * "Invalid RFC7231 date-time value", aborting multipart and single-part
 * uploads alike.
 *
 * The function RFC3339_WITH_OFFSET already exists in the same file and
 * correctly parses Wasabi's format; this patch adds it as a fallback.
 *
 * Patched files:
 *   dist-es  — used by bundlers (electron-vite dev/build)
 *   dist-cjs — used by Node.js / Electron at runtime
 *   dist-cjs/index.browser.js and index.native.js — belt-and-suspenders
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const TARGETS = [
  'node_modules/@smithy/core/dist-es/submodules/serde/schema-serde-lib/schema-date-utils.js',
  'node_modules/@smithy/core/dist-cjs/submodules/serde/index.js',
  'node_modules/@smithy/core/dist-cjs/submodules/serde/index.browser.js',
  'node_modules/@smithy/core/dist-cjs/submodules/serde/index.native.js',
]

const NEEDLE = `    throw new TypeError(\`Invalid RFC7231 date-time value \${value}.\`);`

// The dist-es file uses RFC3339_WITH_OFFSET; the dist-cjs files also define it.
const REPLACEMENT = `    // Fallback: some S3-compatible providers (e.g. Wasabi) return ISO 8601 /
    // RFC 3339 instead of RFC 7231. RFC3339_WITH_OFFSET handles this format.
    const rfc3339Fallback = RFC3339_WITH_OFFSET.exec(value);
    if (rfc3339Fallback) {
        return _parseRfc3339DateTimeWithOffset(value);
    }
    throw new TypeError(\`Invalid RFC7231 date-time value \${value}.\`);`

let patched = 0
let skipped = 0

for (const rel of TARGETS) {
  const target = resolve(root, rel)
  if (!existsSync(target)) {
    console.warn(`[patch-wasabi-compat] Not found, skipping: ${rel}`)
    skipped++
    continue
  }
  const src = readFileSync(target, 'utf8')
  if (src.includes('rfc3339Fallback')) {
    skipped++
    continue
  }
  if (!src.includes(NEEDLE)) {
    console.warn(`[patch-wasabi-compat] Needle not found (SDK version changed?): ${rel}`)
    skipped++
    continue
  }
  writeFileSync(target, src.replace(NEEDLE, REPLACEMENT), 'utf8')
  console.log(`[patch-wasabi-compat] Patched: ${rel}`)
  patched++
}

if (patched > 0) {
  console.log(`[patch-wasabi-compat] Done — patched ${patched} file(s).`)
} else {
  console.log(`[patch-wasabi-compat] All files already patched or skipped (${skipped}).`)
}
