import tls from 'tls'
import { log } from './logger'

type TlsWithCaApi = typeof tls & {
  getCACertificates?: (type: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

/**
 * Make Node's TLS (S3/Wasabi via the AWS SDK, fetch-based providers, OAuth token
 * calls) trust the operating system's certificate store in addition to Node's
 * bundled Mozilla list.
 *
 * Node ignores the OS store by default. On networks that inspect HTTPS (corporate
 * proxies such as Zscaler, or antivirus "web shield" features) traffic is re-signed
 * by a company/vendor root that IS in the OS store, so other apps work while Node
 * fails with "self signed certificate in certificate chain".
 *
 * Fails soft: on any error the default (bundled) trust list stays in effect.
 */
export function trustSystemCertificates(): void {
  const t = tls as TlsWithCaApi
  if (typeof t.getCACertificates !== 'function' || typeof t.setDefaultCACertificates !== 'function') return
  try {
    const bundled = t.getCACertificates('default')
    const system = t.getCACertificates('system')
    const merged = [...new Set([...bundled, ...system])]
    t.setDefaultCACertificates(merged)
    log.info('connection', `TLS trust: using ${bundled.length} bundled + ${merged.length - bundled.length} additional operating-system certificate(s)`)
  } catch (err) {
    log.warn('connection', `Could not load operating-system certificates (${(err as Error).message}); using bundled list only`)
  }
}

/** Default trust list plus the PEM file(s) at `path` — for a per-connection custom CA. */
export function caListWithFile(pem: string): string[] {
  const t = tls as TlsWithCaApi
  const base = typeof t.getCACertificates === 'function' ? t.getCACertificates('default') : [...tls.rootCertificates]
  return [...base, pem]
}
