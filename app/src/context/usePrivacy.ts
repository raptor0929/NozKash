import { useContext } from 'react'
import { PrivacyContext } from './privacy-context'

export function usePrivacy() {
  const ctx = useContext(PrivacyContext)
  if (!ctx) throw new Error('usePrivacy must be used within PrivacyProvider')
  return ctx
}
