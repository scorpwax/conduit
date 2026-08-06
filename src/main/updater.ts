import { app, net } from 'electron'

const REPO = 'scorpwax/conduit'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export interface UpdateInfo {
  version: string
  downloadUrl: string
  releaseUrl: string
  releaseNotes: string
}

function platformExt(): string {
  if (process.platform === 'darwin') return '.dmg'
  if (process.platform === 'win32') return '.exe'
  return '.dmg'
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [aMaj, aMin, aPat] = parse(a)
  const [bMaj, bMin, bPat] = parse(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat > bPat
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const current = app.getVersion()
    const data = await fetchJson(API_URL)
    if (!data || typeof data !== 'object') return null

    const tag: string = (data as Record<string, unknown>).tag_name as string ?? ''
    const remoteVersion = tag.replace(/^v/, '')
    if (!semverGt(remoteVersion, current)) return null

    const assets = ((data as Record<string, unknown>).assets as Array<Record<string, string>>) ?? []
    const ext = platformExt()
    const asset = assets.find((a) => a.name?.endsWith(ext))

    const releaseUrl = (data as Record<string, unknown>).html_url as string ?? `https://github.com/${REPO}/releases/latest`
    const downloadUrl = asset?.browser_download_url ?? releaseUrl
    const body = (data as Record<string, unknown>).body as string ?? ''
    const releaseNotes = body.split('\n').slice(0, 5).join(' ').trim()

    return { version: remoteVersion, downloadUrl, releaseUrl, releaseNotes }
  } catch {
    return null
  }
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url,
      method: 'GET',
      headers: { 'User-Agent': `Conduit/${app.getVersion()}` }
    })
    let body = ''
    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}
