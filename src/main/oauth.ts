import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { shell } from 'electron'

/**
 * Generic OAuth 2.0 Authorization Code + PKCE flow for desktop apps.
 *
 * Opens the system browser to the provider's consent page, runs a temporary
 * loopback HTTP server to catch the redirect, and exchanges the code for
 * tokens. Works for Google, Microsoft, Dropbox — each just supplies different
 * endpoints/scopes.
 */

export interface OAuthProviderConfig {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  clientSecret?: string
  /** Extra params appended to the authorize URL (e.g. access_type=offline). */
  extraAuthParams?: Record<string, string>
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface Loopback {
  port: number
  redirectUri: string
  waitForCode: () => Promise<string>
}

/** Start a one-shot loopback server that resolves with the OAuth code. */
function startLoopback(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        `<html><body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">
           <div style="text-align:center">
             <h2>${error ? 'Authorization failed' : 'Connected to Conduit ✓'}</h2>
             <p style="color:#9aa4b2">${error ? error : 'You can close this window and return to Conduit.'}</p>
           </div>
         </body></html>`
      )
      server.close()
      if (error) rejectCode(new Error(error))
      else if (code) resolveCode(code)
      else rejectCode(new Error('No authorization code returned'))
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        resolve({ port, redirectUri: `http://127.0.0.1:${port}`, waitForCode: () => codePromise })
      } else {
        reject(new Error('Failed to bind loopback server'))
      }
    })
  })
}

/** Run the full interactive authorization flow and return tokens. */
export async function runOAuth(cfg: OAuthProviderConfig): Promise<OAuthTokens> {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const { redirectUri, waitForCode } = await startLoopback()

  const authUrl = new URL(cfg.authUrl)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', cfg.scopes.join(' '))
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) {
    authUrl.searchParams.set(k, v)
  }

  await shell.openExternal(authUrl.toString())
  const code = await waitForCode()

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret)

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshTokens(
  cfg: OAuthProviderConfig,
  refreshToken: string
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret)

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
  }
}
