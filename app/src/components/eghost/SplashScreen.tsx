import { useEffect, useState } from 'react'

const SPLASH_SRC = `${import.meta.env.BASE_URL}NozKash_splash_v1.1.svg`

/** NozKash v1.1 intro (animation in SVG; ~3.5s + brief pause before fade). */
export function SplashScreen() {
  const [phase, setPhase] = useState<'visible' | 'hiding' | 'gone'>('visible')

  useEffect(() => {
    const t1 = window.setTimeout(() => setPhase('hiding'), 4200)
    const t2 = window.setTimeout(() => setPhase('gone'), 4800)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [])

  if (phase === 'gone') return null

  return (
    <div
      id="splash"
      className={phase === 'hiding' ? 'hide' : undefined}
      aria-hidden
    >
      <img src={SPLASH_SRC} alt="" decoding="async" draggable={false} />
    </div>
  )
}
