interface LogoProps {
	size?: number
	className?: string
}

/**
 * The Conduit mark: two arrows threading through a rounded channel in opposite
 * directions — data flowing between two endpoints. Uses currentColor-friendly
 * gradients so it reads on dark or light surfaces.
 */
export function Logo({ size = 28, className }: LogoProps): JSX.Element {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 64 64"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			role="img"
			aria-label="Conduit"
		>
			<defs>
				<linearGradient id="conduit-a" x1="8" y1="20" x2="56" y2="20" gradientUnits="userSpaceOnUse">
					<stop stopColor="#3b82f6" />
					<stop offset="1" stopColor="#22d3ee" />
				</linearGradient>
				<linearGradient id="conduit-b" x1="56" y1="44" x2="8" y2="44" gradientUnits="userSpaceOnUse">
					<stop stopColor="#a78bfa" />
					<stop offset="1" stopColor="#f472b6" />
				</linearGradient>
			</defs>
			{/* channel */}
			<rect x="4" y="10" width="56" height="44" rx="14" fill="currentColor" opacity="0.08" />
			<rect x="4" y="10" width="56" height="44" rx="14" stroke="currentColor" opacity="0.15" />
			{/* top arrow, left -> right */}
			<path
				d="M14 24 H42"
				stroke="url(#conduit-a)"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<path
				d="M38 18 L48 24 L38 30"
				stroke="url(#conduit-a)"
				strokeWidth="5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{/* bottom arrow, right -> left */}
			<path
				d="M50 40 H22"
				stroke="url(#conduit-b)"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<path
				d="M26 34 L16 40 L26 46"
				stroke="url(#conduit-b)"
				strokeWidth="5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}
