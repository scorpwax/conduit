/**
 * Patches @smithy/core's _parseRfc7231DateTime to handle two non-standard
 * date formats Wasabi has been observed sending in response headers (e.g.
 * `Expires`), instead of throwing and aborting the whole upload/transfer:
 *
 * 1. ISO 8601 / RFC 3339 (e.g. "2026-07-22T18:18:46Z") instead of RFC 7231.
 * 2. Go's `time.Time.String()` debug format (e.g.
 *    "2026-09-08 22:38:10.499906814 +0000 UTC m=+605635.748080191") —
 *    never meant to be sent over the wire (that trailing `m=+...` is Go's
 *    internal monotonic clock reading), but Wasabi has sent it at least once.
 *    Reformatted into RFC 3339 and handed to the same fallback as #1.
 *
 * Each fallback is applied as its own idempotent patch (checked separately),
 * so re-running this after an SDK upgrade only re-applies whichever ones are
 * missing — including upgrading an install that only has the older,
 * single-fallback version of this patch.
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

const THROW_LINE = `    throw new TypeError(\`Invalid RFC7231 date-time value \${value}.\`);`

// Both replacements end with the same throw line unchanged, so the second
// patch can still find and extend it after the first has already been applied.
const PATCHES = [
  {
    marker: 'rfc3339Fallback',
    needle: THROW_LINE,
    replacement: `    // Fallback: some S3-compatible providers (e.g. Wasabi) return ISO 8601 /
    // RFC 3339 instead of RFC 7231. RFC3339_WITH_OFFSET handles this format.
    const rfc3339Fallback = RFC3339_WITH_OFFSET.exec(value);
    if (rfc3339Fallback) {
        return _parseRfc3339DateTimeWithOffset(value);
    }
    ${THROW_LINE.trim()}`
  },
  {
    marker: 'goTimeStringFallback',
    needle: THROW_LINE,
    replacement: `    // Fallback: Wasabi has been observed sending Go's time.Time debug
    // string format instead of a real date (e.g. "2026-09-08 22:38:10.4999
    // +0000 UTC m=+605635.748"). Reformat the real date/time/offset portion
    // as RFC 3339 and reuse the existing RFC 3339 parser above.
    const goTimeStringFallback = /^(\\d{4})-(\\d\\d)-(\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d)(\\.\\d+)? ([-+]\\d{4}) \\S+(?: m=.*)?$/.exec(value);
    if (goTimeStringFallback) {
        const [, y, mo, d, h, mi, s, frac, offset] = goTimeStringFallback;
        const iso = \`\${y}-\${mo}-\${d}T\${h}:\${mi}:\${s}\${frac || ''}\${offset.slice(0, 3)}:\${offset.slice(3)}\`;
        return _parseRfc3339DateTimeWithOffset(iso);
    }
    ${THROW_LINE.trim()}`
  }
]

let patched = 0
let skipped = 0

for (const rel of TARGETS) {
  const target = resolve(root, rel)
  if (!existsSync(target)) {
    console.warn(`[patch-wasabi-compat] Not found, skipping: ${rel}`)
    skipped++
    continue
  }
  let src = readFileSync(target, 'utf8')
  let fileChanged = false
  for (const { marker, needle, replacement } of PATCHES) {
    if (src.includes(marker)) continue // this fallback already applied
    if (!src.includes(needle)) {
      console.warn(`[patch-wasabi-compat] Needle not found for '${marker}' (SDK version changed?): ${rel}`)
      continue
    }
    src = src.replace(needle, replacement)
    fileChanged = true
  }
  if (fileChanged) {
    writeFileSync(target, src, 'utf8')
    console.log(`[patch-wasabi-compat] Patched: ${rel}`)
    patched++
  } else {
    skipped++
  }
}

if (patched > 0) {
  console.log(`[patch-wasabi-compat] Done — patched ${patched} file(s).`)
} else {
  console.log(`[patch-wasabi-compat] All files already patched or skipped (${skipped}).`)
}
