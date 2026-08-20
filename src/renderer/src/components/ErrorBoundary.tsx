import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
	children: ReactNode
}

interface State {
	error: Error | null
}

// Transfers run entirely in the main process, so a render exception here never
// stops an in-flight transfer — it just blanks the window if left uncaught.
// Catch it and offer a reload instead of leaving the user staring at nothing.
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		void window.conduit.logs.write('error', 'app', `Renderer crashed: ${error.message}\n${info.componentStack ?? ''}`)
	}

	render(): ReactNode {
		if (!this.state.error) return this.props.children
		return (
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100vh',
					gap: 16,
					background: '#0f1115',
					color: '#e6e6e6',
					fontFamily: 'system-ui, sans-serif',
					textAlign: 'center',
					padding: 24
				}}
			>
				<div style={{ fontSize: 18, fontWeight: 600 }}>Conduit hit a display error</div>
				<div style={{ opacity: 0.7, maxWidth: 420 }}>
					Any transfers already in progress are unaffected and keep running in the background.
					Reload the window to restore the display.
				</div>
				<button
					className="btn"
					style={{ padding: '8px 20px', cursor: 'pointer' }}
					onClick={() => window.location.reload()}
				>
					Reload
				</button>
			</div>
		)
	}
}
