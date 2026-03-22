import { createContext } from 'react'

export type PrivacyContextValue = {
  privacyOn: boolean
  togglePrivacy: () => void
}

export const PrivacyContext = createContext<PrivacyContextValue | null>(null)
