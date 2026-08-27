import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SpeedGraphWindow } from './components/SpeedGraphWindow'
import { ErrorBoundary } from './components/ErrorBoundary'
import 'material-symbols/outlined.css'
import './styles.css'

// The speed-graph pop-out is a second BrowserWindow loading this same bundle,
// routed by URL hash (see main/index.ts openSpeedGraphWindow) — no router
// dependency needed for a single alternate top-level view.
const isSpeedGraphWindow = window.location.hash === '#speed-graph'

// StrictMode intentionally double-invokes effects (mount→unmount→remount) in
// development to surface non-idempotent side-effects. In an Electron app with
// IPC subscriptions this causes real listener duplication, so we skip it.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<ErrorBoundary>
		{isSpeedGraphWindow ? <SpeedGraphWindow /> : <App />}
	</ErrorBoundary>
)
