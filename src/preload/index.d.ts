import type { ConduitApi } from './index'

declare global {
  interface Window {
    conduit: ConduitApi
  }
}

export {}
