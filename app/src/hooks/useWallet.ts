import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureTargetChain,
  getEthereum,
  NATIVE_CURRENCY_SYMBOL,
  parseEthAddressList,
  targetChainMismatchUserMessage,
  TARGET_CHAIN_ID,
  TARGET_NETWORK_LABEL,
  weiHexToNativeLabel,
  WRONG_NETWORK_LABEL,
} from '../lib/ethereum'

/** Interval for `eth_getBalance` while a wallet account is selected (keeps native ETH in sync after txs). */
export const WALLET_BALANCE_POLL_MS = 6_000

/** Dispatched after deposit/redeem so every `useWallet()` instance refetches (hooks are not shared). */
export const WALLET_BALANCE_REFRESH_EVENT = 'ghost:wallet-balance-refresh'

export function requestWalletBalanceRefresh(): void {
  window.dispatchEvent(new Event(WALLET_BALANCE_REFRESH_EVENT))
}

type EthereumProvider = {
  request: (args: {
    method: string
    params?: unknown[]
  }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (
    event: string,
    handler: (...args: unknown[]) => void
  ) => void
}

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function getEthereumProvider(): EthereumProvider | undefined {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum
}

function normalizeChainId(chainId: unknown): string | null {
  if (typeof chainId !== 'string') return null
  return chainId.toLowerCase()
}

function parseAccounts(accs: unknown): string[] {
  if (!Array.isArray(accs)) return []
  return accs.filter((a): a is string => typeof a === 'string' && a.startsWith('0x'))
}

export function useWallet() {
  const [accounts, setAccounts] = useState<string[]>([])
  const [account, setAccount] = useState<string | null>(null)
  /** Hex with 0x prefix, lowercase; null until first provider read. */
  const [chainIdHex, setChainIdHex] = useState<string | null>(null)
  const [network, setNetwork] = useState<string>(WRONG_NETWORK_LABEL)
  const [balanceWeiHex, setBalanceWeiHex] = useState<string | null>(null)
  const accountsRef = useRef<string[]>([])
  accountsRef.current = accounts

  const refreshBalance = useCallback(async () => {
    const ethereum = getEthereum()
    if (!ethereum || !account) {
      setBalanceWeiHex(null)
      return
    }
    try {
      const hex = (await ethereum.request({
        method: 'eth_getBalance',
        params: [account, 'latest'],
      })) as string
      setBalanceWeiHex(hex)
    } catch {
      setBalanceWeiHex(null)
    }
  }, [account])

  useEffect(() => {
    const ethereum = getEthereum()
    if (!ethereum || !account) {
      setBalanceWeiHex(null)
      return
    }
    let cancelled = false
    const fetchOnce = () => {
      ethereum
        .request({ method: 'eth_getBalance', params: [account, 'latest'] })
        .then((hex) => {
          if (!cancelled) setBalanceWeiHex(hex as string)
        })
        .catch(() => {
          if (!cancelled) setBalanceWeiHex(null)
        })
    }
    fetchOnce()
    const id = window.setInterval(fetchOnce, WALLET_BALANCE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [account, network])

  useEffect(() => {
    const onRefresh = () => {
      void refreshBalance()
    }
    window.addEventListener(WALLET_BALANCE_REFRESH_EVENT, onRefresh)
    return () =>
      window.removeEventListener(WALLET_BALANCE_REFRESH_EVENT, onRefresh)
  }, [refreshBalance])

  const homeBalanceMain = useMemo(() => {
    if (!balanceWeiHex) return null
    return weiHexToNativeLabel(balanceWeiHex, NATIVE_CURRENCY_SYMBOL, 4)
  }, [balanceWeiHex])

  const homeBalanceUsd = useMemo(() => {
    if (!balanceWeiHex) return null
    const eth = Number(BigInt(balanceWeiHex)) / 1e18
    if (!Number.isFinite(eth)) return null
    return `≈ $${(eth * 2417).toFixed(2)} USD`
  }, [balanceWeiHex])

  const isConnected = useMemo(
    () => account !== null && network === TARGET_NETWORK_LABEL,
    [account, network]
  )

  const refreshNetwork = useCallback(async () => {
    const ethereum = getEthereumProvider()
    if (!ethereum) return

    const chainId = normalizeChainId(
      await ethereum.request({ method: 'eth_chainId' })
    )
    setChainIdHex(chainId)
    if (chainId === TARGET_CHAIN_ID) setNetwork(TARGET_NETWORK_LABEL)
    else setNetwork(WRONG_NETWORK_LABEL)
  }, [])

  const selectAccount = useCallback((address: string) => {
    if (!accountsRef.current.includes(address)) return
    setAccount(address)
  }, [])

  useEffect(() => {
    const ethereum = getEthereumProvider()
    if (!ethereum) return

    let isCancelled = false

    ;(async () => {
      try {
        const [accs, chainId] = await Promise.all([
          ethereum.request({ method: 'eth_accounts' }) as Promise<unknown>,
          ethereum.request({ method: 'eth_chainId' }),
        ])

        if (isCancelled) return

        const list = parseAccounts(accs)
        setAccounts(list)
        /** The wallet returns the selected account first; always use list[0] (keeping stale `prev` desyncs balance when switching accounts in the extension). */
        setAccount(list.length > 0 ? list[0] : null)
        const normalized = normalizeChainId(chainId)
        setChainIdHex(normalized)
        setNetwork(
          normalized === TARGET_CHAIN_ID
            ? TARGET_NETWORK_LABEL
            : WRONG_NETWORK_LABEL
        )
      } catch (err) {
        if (isCancelled) return
        console.error('Wallet init failed', err)
      }
    })()

    const handleAccountsChanged = (accs: unknown) => {
      const list = parseAccounts(accs)
      setAccounts(list)
      setAccount(list.length > 0 ? list[0] : null)
    }
    const handleChainChanged = (newChainId: unknown) => {
      const normalized = normalizeChainId(newChainId)
      setChainIdHex(normalized)
      setNetwork(
        normalized === TARGET_CHAIN_ID
          ? TARGET_NETWORK_LABEL
          : WRONG_NETWORK_LABEL
      )
    }

    if (typeof ethereum?.on === 'function') {
      ethereum.on('accountsChanged', handleAccountsChanged)
      ethereum.on('chainChanged', handleChainChanged)
    }

    return () => {
      isCancelled = true
      if (typeof ethereum?.removeListener === 'function') {
        ethereum.removeListener('accountsChanged', handleAccountsChanged)
        ethereum.removeListener('chainChanged', handleChainChanged)
      }
    }
  }, [])

  const connectWallet = useCallback(async () => {
    const ethereum = getEthereumProvider()
    if (!ethereum) {
      window.alert('No Ethereum wallet found. Install a browser wallet extension.')
      return
    }

    try {
      const accs = parseAccounts(
        await ethereum.request({ method: 'eth_requestAccounts' })
      )

      setAccounts(accs)
      setAccount(accs[0] ?? null)

      const chainIdBefore = normalizeChainId(
        await ethereum.request({ method: 'eth_chainId' })
      )

      if (chainIdBefore !== TARGET_CHAIN_ID) {
        const ok = await ensureTargetChain(ethereum)
        if (!ok) {
          await refreshNetwork()
          return
        }
      }

      await refreshNetwork()
    } catch (err) {
      console.error('connectWallet failed', err)
      await refreshNetwork()
    }
  }, [refreshNetwork])

  const disconnectWallet = useCallback(async () => {
    const ethereum = getEthereumProvider()
    if (ethereum?.request) {
      try {
        await ethereum.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        })
      } catch {
        /* Older wallets or other providers: still clear the UI */
      }
    }
    setAccounts([])
    setAccount(null)
  }, [])

  /**
   * Same flow as Add deposit / Redeem: target chain → `wallet_requestPermissions` (pick
   * accounts in the wallet) → `eth_requestAccounts` → active account from `eth_accounts`.
   */
  const openWalletAccountPicker = useCallback(async (): Promise<boolean> => {
    const ethereum = getEthereum()
    if (!ethereum) {
      window.alert('No Ethereum wallet found. Install a browser wallet extension.')
      return false
    }
    try {
      const okChain = await ensureTargetChain(ethereum)
      if (!okChain) {
        window.alert(targetChainMismatchUserMessage())
        return false
      }

      try {
        await ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }],
        })
      } catch (permErr: unknown) {
        const pe = permErr as { code?: number }
        if (pe.code === 4001) return false
      }

      let accs: string[]
      try {
        accs = parseEthAddressList(
          await ethereum.request({ method: 'eth_requestAccounts' })
        )
      } catch {
        return false
      }

      if (accs.length === 0) return false

      await new Promise((r) => window.setTimeout(r, 300))

      const fresh = parseEthAddressList(
        await ethereum.request({ method: 'eth_accounts' })
      )
      const active = fresh[0] ?? accs[0]
      if (!active) return false

      setAccounts(accs)
      setAccount(active)
      await refreshNetwork()
      return true
    } catch (err) {
      console.error('openWalletAccountPicker failed', err)
      return false
    }
  }, [refreshNetwork])

  return {
    connectWallet,
    disconnectWallet,
    openWalletAccountPicker,
    accounts,
    account,
    chainIdHex,
    selectAccount,
    isConnected,
    network,
    truncatedAddress: account ? truncateAddress(account) : null,
    homeBalanceMain,
    homeBalanceUsd,
    refreshBalance,
  }
}
