import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useWallet } from '../hooks/useWallet'
import {
  buildGhostDerivationSignMessage,
  masterSeedFromPersonalSignSignature,
} from '../lib/deriveMasterSeedFromWallet'
import { getEthereum } from '../lib/ethereum'
import {
  getGhostMasterSeedFromEnv,
  GHOST_MASTER_SEED_CHANGED_EVENT,
} from '../lib/ghostVault'

type WalletUnlock = {
  seed: Uint8Array
  account: string
  /** eth_chainId normalizado minúsculas */
  chainId: string
}

async function personalSignMasterSeed(
  ethereum: NonNullable<ReturnType<typeof getEthereum>>,
  account: string,
  chainIdHex: string
): Promise<Uint8Array | null> {
  try {
    const message = buildGhostDerivationSignMessage(account, chainIdHex)
    const sig = (await ethereum.request({
      method: 'personal_sign',
      params: [message, account],
    })) as string
    return masterSeedFromPersonalSignSignature(sig)
  } catch (e) {
    const err = e as { code?: number }
    if (err?.code !== 4001) {
      console.error('personal_sign (Ghost master seed)', e)
    }
    return null
  }
}

export type GhostMasterSeedContextValue = {
  effectiveMasterSeed: Uint8Array | null
  hasSignedUnlock: boolean
  seedRevision: number
  /** Si falló el auto al conectar; persiste solo en memoria mientras la wallet sigue conectada. */
  requestUnlockViaSign: (forAccount?: string) => Promise<Uint8Array | null>
  /** Borra la semilla en memoria (p. ej. otra cuenta en el mismo dispositivo). */
  clearSignedUnlock: () => Promise<void>
}

const GhostMasterSeedContext = createContext<GhostMasterSeedContextValue | null>(
  null
)

export function GhostMasterSeedProvider({ children }: { children: ReactNode }) {
  const { account, chainIdHex } = useWallet()
  const [unlock, setUnlock] = useState<WalletUnlock | null>(null)
  const unlockRef = useRef<WalletUnlock | null>(null)
  unlockRef.current = unlock

  const [seedRevision, setSeedRevision] = useState(0)

  const bump = useCallback(() => {
    setSeedRevision((r) => r + 1)
    window.dispatchEvent(new Event(GHOST_MASTER_SEED_CHANGED_EVENT))
  }, [])

  /** Sin env: semilla solo en RAM; al desconectar (`account` null) se borra. Sin localStorage. */
  useEffect(() => {
    if (getGhostMasterSeedFromEnv()) {
      setUnlock(null)
      return
    }

    if (!account || !chainIdHex) {
      setUnlock(null)
      return
    }

    const ethereum = getEthereum()
    if (!ethereum) return

    const cid = chainIdHex.toLowerCase()

    const u = unlockRef.current
    if (
      u &&
      u.account.toLowerCase() === account.toLowerCase() &&
      u.chainId === cid
    ) {
      return
    }

    let cancelled = false

    void (async () => {
      const seed = await personalSignMasterSeed(ethereum, account, chainIdHex)
      if (cancelled) return
      if (!seed) {
        setUnlock(null)
        return
      }
      setUnlock({
        seed,
        account,
        chainId: cid,
      })
      bump()
    })()

    return () => {
      cancelled = true
    }
  }, [account, chainIdHex, bump])

  const effectiveMasterSeed = useMemo(() => {
    const env = getGhostMasterSeedFromEnv()
    if (env) return env
    if (!account || !chainIdHex || !unlock) return null
    const cid = chainIdHex.toLowerCase()
    if (
      unlock.account.toLowerCase() === account.toLowerCase() &&
      unlock.chainId === cid
    ) {
      return unlock.seed
    }
    return null
  }, [account, chainIdHex, unlock, seedRevision])

  const hasSignedUnlock = Boolean(
    !getGhostMasterSeedFromEnv() && effectiveMasterSeed
  )

  const requestUnlockViaSign = useCallback(
    async (forAccount?: string): Promise<Uint8Array | null> => {
      const ethereum = getEthereum()
      const acct = forAccount ?? account
      const cid = chainIdHex?.toLowerCase()
      if (!ethereum || !acct || !cid) return null
      const seed = await personalSignMasterSeed(ethereum, acct, chainIdHex!)
      if (!seed) return null
      setUnlock({ seed, account: acct, chainId: cid })
      bump()
      return seed
    },
    [account, chainIdHex, bump]
  )

  const clearSignedUnlock = useCallback(async () => {
    setUnlock(null)
    bump()
  }, [bump])

  const value = useMemo(
    () => ({
      effectiveMasterSeed,
      hasSignedUnlock,
      seedRevision,
      requestUnlockViaSign,
      clearSignedUnlock,
    }),
    [
      effectiveMasterSeed,
      hasSignedUnlock,
      seedRevision,
      requestUnlockViaSign,
      clearSignedUnlock,
    ]
  )

  return (
    <GhostMasterSeedContext.Provider value={value}>
      {children}
    </GhostMasterSeedContext.Provider>
  )
}

export function useGhostMasterSeed(): GhostMasterSeedContextValue {
  const ctx = useContext(GhostMasterSeedContext)
  if (!ctx) {
    throw new Error('useGhostMasterSeed debe usarse dentro de GhostMasterSeedProvider')
  }
  return ctx
}
