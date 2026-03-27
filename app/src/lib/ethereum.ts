import { chainRpcCall, getChainPublicRpcUrl } from './chainPublicRpc'

export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

export function getEthereum(): EthereumProvider | null {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum ?? null
}

/** Normalizes `eth_accounts` / `eth_requestAccounts` responses to `0x` addresses. */
export function parseEthAddressList(x: unknown): string[] {
  if (!Array.isArray(x)) return []
  return x.filter(
    (a): a is string => typeof a === 'string' && a.startsWith('0x')
  )
}

function normalizeHexChainId(raw: string | undefined): string {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return '0xaa36a7'
  return s.startsWith('0x') ? s : `0x${s}`
}

/**
 * Wallet / app target chain (`eth_chainId`), lowercase hex.
 * Set `VITE_CHAIN_ID` (e.g. `0xaa36a7` or `aa36a7`).
 */
export const TARGET_CHAIN_ID = normalizeHexChainId(
  import.meta.env.VITE_CHAIN_ID as string | undefined
)

/** Decimal string for UI / errors (e.g. `11155111`). */
export const TARGET_CHAIN_ID_DECIMAL = BigInt(TARGET_CHAIN_ID).toString()

/**
 * Short label when the wallet is on the target chain (activity subtitles, etc.).
 * Prefer `VITE_CHAIN_DISPLAY_NAME`; falls back to `VITE_CHAIN_NAME`.
 */
export const TARGET_NETWORK_LABEL = (() => {
  const a = (import.meta.env.VITE_CHAIN_DISPLAY_NAME as string | undefined)?.trim()
  if (a) return a
  const b = (import.meta.env.VITE_CHAIN_NAME as string | undefined)?.trim()
  if (b) return b
  return 'Network'
})()

/** Shown in `wallet_addEthereumChain` — set `VITE_CHAIN_NAME` (e.g. `Arbitrum One`). */
const WALLET_CHAIN_NAME = (() => {
  const n = (import.meta.env.VITE_CHAIN_NAME as string | undefined)?.trim()
  return n || 'Ethereum'
})()

/** Native token symbol for balances / gas hints (set `VITE_NATIVE_CURRENCY_SYMBOL`). */
export const NATIVE_CURRENCY_SYMBOL =
  (import.meta.env.VITE_NATIVE_CURRENCY_SYMBOL as string | undefined)?.trim() ||
  'ETH'

const NATIVE_SYMBOL = NATIVE_CURRENCY_SYMBOL
const NATIVE_NAME =
  (import.meta.env.VITE_NATIVE_CURRENCY_NAME as string | undefined)?.trim() ||
  'Ether'
const NATIVE_DECIMALS_RAW =
  import.meta.env.VITE_NATIVE_CURRENCY_DECIMALS as string | undefined
const NATIVE_DECIMALS = (() => {
  const n = Number.parseInt(NATIVE_DECIMALS_RAW ?? '18', 10)
  return Number.isFinite(n) && n >= 0 ? n : 18
})()

function blockExplorerUrls(): string[] | undefined {
  const u = (import.meta.env.VITE_BLOCK_EXPLORER_URL as string | undefined)?.trim()
  if (!u) return undefined
  return [u]
}

function walletAddEthereumChainParams() {
  const explorer = blockExplorerUrls()
  return {
    chainId: TARGET_CHAIN_ID,
    chainName: WALLET_CHAIN_NAME,
    nativeCurrency: {
      name: NATIVE_NAME,
      symbol: NATIVE_SYMBOL,
      decimals: NATIVE_DECIMALS,
    },
    rpcUrls: [getChainPublicRpcUrl()],
    ...(explorer ? { blockExplorerUrls: explorer } : {}),
  }
}

export const WRONG_NETWORK_LABEL = 'Wrong Network' as const

export function targetChainMismatchUserMessage(): string {
  return `Switch to ${TARGET_NETWORK_LABEL} (chain id ${TARGET_CHAIN_ID_DECIMAL}) in your wallet.`
}

/** UI line like `Ethereum · Arbitrum` when `VITE_WALLET_NETWORK_TAG` is set, else {@link TARGET_NETWORK_LABEL}. */
export function walletNetworkBadgeLabel(): string {
  const tag = (import.meta.env.VITE_WALLET_NETWORK_TAG as string | undefined)?.trim()
  if (tag) return `${WALLET_CHAIN_NAME} · ${tag}`
  return TARGET_NETWORK_LABEL
}

/** Converts `eth_getBalance` (hex wei) to a label with the native symbol (e.g. ETH). */
export function weiHexToNativeLabel(
  weiHex: string,
  symbol: string,
  fractionDigits = 4
): string {
  const wei = BigInt(weiHex)
  const n = Number(wei) / 1e18
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(fractionDigits)} ${symbol}`
}

export function normalizeChainId(chainId: unknown): string | null {
  if (typeof chainId !== 'string') return null
  return chainId.toLowerCase()
}

const RECEIPT_POLL_INTERVAL_MS = 10_000
const RECEIPT_POLL_MAX_ATTEMPTS = 11

/**
 * Polls for a mined receipt. Prefer `options.ethereum` so the wallet’s RPC is used.
 * Falls back to {@link chainRpcCall} when no provider is passed.
 */
export async function waitForTransactionReceipt(
  txHash: string,
  options?: { ethereum?: EthereumProvider }
): Promise<{ status?: string }> {
  const poll = async (): Promise<{ status?: string } | null> => {
    if (options?.ethereum) {
      const r = await options.ethereum.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      })
      return r as { status?: string } | null
    }
    return chainRpcCall<{ status?: string } | null>(
      'eth_getTransactionReceipt',
      [txHash]
    )
  }
  for (let i = 0; i < RECEIPT_POLL_MAX_ATTEMPTS; i++) {
    const receipt = await poll()
    if (receipt) return receipt
    if (i < RECEIPT_POLL_MAX_ATTEMPTS - 1) {
      await new Promise((r) => window.setTimeout(r, RECEIPT_POLL_INTERVAL_MS))
    }
  }
  throw new Error(
    `Timed out waiting for confirmation (${RECEIPT_POLL_MAX_ATTEMPTS} receipt checks, ${RECEIPT_POLL_INTERVAL_MS}ms between checks)`
  )
}

export async function estimateSimpleTransferGasNative(
  ethereum: EthereumProvider,
  nativeSymbol = NATIVE_SYMBOL
): Promise<string> {
  try {
    const gasPriceHex = (await ethereum.request({
      method: 'eth_gasPrice',
      params: [],
    })) as string
    const gasPrice = BigInt(gasPriceHex)
    const gasLimit = 21000n
    const wei = gasPrice * gasLimit
    const n = Number(wei) / 1e18
    if (!Number.isFinite(n) || n <= 0) return '—'
    if (n < 0.000001) return `< 0.000001 ${nativeSymbol}`
    return `~${n.toFixed(6)} ${nativeSymbol}`
  } catch {
    return '—'
  }
}

/**
 * Ensures the wallet is on {@link TARGET_CHAIN_ID}: `wallet_switchEthereumChain` or `wallet_addEthereumChain`.
 */
export async function ensureTargetChain(
  ethereum: EthereumProvider
): Promise<boolean> {
  const id = normalizeChainId(await ethereum.request({ method: 'eth_chainId' }))
  if (id === TARGET_CHAIN_ID) return true
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: TARGET_CHAIN_ID }],
    })
    return (
      normalizeChainId(await ethereum.request({ method: 'eth_chainId' })) ===
      TARGET_CHAIN_ID
    )
  } catch (e: unknown) {
    const code = (e as { code?: number }).code
    if (code !== 4902) return false
    try {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [walletAddEthereumChainParams()],
      })
      return (
        normalizeChainId(await ethereum.request({ method: 'eth_chainId' })) ===
        TARGET_CHAIN_ID
      )
    } catch {
      return false
    }
  }
}

/** @deprecated Use {@link TARGET_CHAIN_ID} */
export const SEPOLIA_CHAIN_ID = TARGET_CHAIN_ID

/** @deprecated Use {@link TARGET_CHAIN_ID} */
export const FUJI_CHAIN_ID = TARGET_CHAIN_ID

/** @deprecated Use {@link ensureTargetChain} */
export async function ensureSepolia(
  ethereum: EthereumProvider
): Promise<boolean> {
  return ensureTargetChain(ethereum)
}
