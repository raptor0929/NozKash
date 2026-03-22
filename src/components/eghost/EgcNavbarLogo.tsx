import { useId } from 'react'

/** NozKash wordmark (animation in `eghostcash.css`, `nzkm-*` classes). */
export function EgcNavbarLogo() {
  const clipId = `nzkm-clip-${useId().replace(/:/g, '')}`

  return (
    <div className="navbar-logo">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 160 52"
        width={130}
        height={42}
        aria-hidden
      >
        <defs>
          <clipPath id={clipId}>
            <rect width="160" height="52" rx="10" />
          </clipPath>
        </defs>
        <rect className="nzkm-logo-bg" width="160" height="52" rx="10" />
        <g clipPath={`url(#${clipId})`}>
          <rect
            className="nzkm-scan-line"
            x="12"
            y="40"
            height="1.5"
            rx="0.8"
            fill="#E84142"
            width="0"
          />
          <g className="nzkm-wordmark-g">
            <text
              y="34"
              fontFamily="'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif"
              fontWeight="600"
              fontSize="24"
              letterSpacing="-0.8"
            >
              <tspan className="nzkm-noz-text" x="12" fill="#FFFFFF">
                Noz
              </tspan>
              <tspan className="nzkm-kash-text" fill="#E84142">
                Kash
              </tspan>
            </text>
          </g>
        </g>
      </svg>
    </div>
  )
}
