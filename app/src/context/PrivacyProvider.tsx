import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { PrivacyContext } from './privacy-context'

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [privacyOn, setPrivacyOn] = useState(false)

  const togglePrivacy = useCallback(() => {
    setPrivacyOn((v) => !v)
  }, [])

  const value = useMemo(
    () => ({ privacyOn, togglePrivacy }),
    [privacyOn, togglePrivacy]
  )

  return (
    <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>
  )
}
