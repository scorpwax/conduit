import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import 'material-symbols/outlined.css'
import './styles.css'

// StrictMode intentionally double-invokes effects (mount→unmount→remount) in
// development to surface non-idempotent side-effects. In an Electron app with
// IPC subscriptions this causes real listener duplication, so we skip it.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<ErrorBoundary>
		<App />
	</ErrorBoundary>
)
