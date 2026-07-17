import type { Connection } from './types'

/**
 * An always-available local connection rooted at the filesystem root, so users
 * can browse drives immediately without first saving a connection. It is not
 * persisted; the main process recognizes its id and builds a provider on the fly.
 */
export const BUILTIN_LOCAL_ID = 'builtin:local'

export const BUILTIN_LOCAL: Connection = {
  id: BUILTIN_LOCAL_ID,
  name: 'This Computer',
  type: 'local',
  config: { rootPath: '/' },
  favorite: false,
  createdAt: '1970-01-01T00:00:00.000Z'
}
