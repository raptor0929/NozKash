import { fujiRpcCall, PUBLIC_FUJI_HTTPS_RPC } from './fujiJsonRpc'

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

/** Avalanche Fuji Testnet (chainlist.org/chain/43113) */
export const FUJI_CHAIN_ID = '0xa869'

const FUJI_ADD_CHAIN_PARAMS = {
  chainId: FUJI_CHAIN_ID,
  chainName: 'Avalanche Fuji Testnet',
  nativeCurrency: {
    name: 'Avalanche',
    symbol: 'AVAX',
    decimals: 18,
  },
  rpcUrls: [PUBLIC_FUJI_HTTPS_RPC],
  blockExplorerUrls: ['https://testnet.snowtrace.io'],
} as const

/** Converts `eth_getBalance` (hex wei) to a label with the native symbol (e.g. AVAX). */
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

/** ~5 min de ventana con pocas consultas: (intentos − 1) × intervalo ≈ 5 min. */
const RECEIPT_POLL_INTERVAL_MS = 30_000
const RECEIPT_POLL_MAX_ATTEMPTS = 11

/**
 * Polls Fuji via HTTP RPC (no MetaMask).
 * Intervalo largo para no saturar el proveedor; hasta ~5 min de espera.
 */
export async function waitForTransactionReceipt(
  txHash: string
): Promise<{ status?: string }> {
  for (let i = 0; i < RECEIPT_POLL_MAX_ATTEMPTS; i++) {
    const receipt = await fujiRpcCall<{ status?: string } | null>(
      'eth_getTransactionReceipt',
      [txHash]
    )
    if (receipt) return receipt
    if (i < RECEIPT_POLL_MAX_ATTEMPTS - 1) {
      await new Promise((r) => window.setTimeout(r, RECEIPT_POLL_INTERVAL_MS))
    }
  }
  throw new Error(
    'Timed out waiting for confirmation (~5 min, sparse RPC polling)'
  )
}

export async function estimateSimpleTransferGasNative(
  ethereum: EthereumProvider,
  nativeSymbol = 'AVAX'
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
 * Ensures Avalanche Fuji (43113): `wallet_switchEthereumChain` or `wallet_addEthereumChain`.
 */
export async function ensureFuji(ethereum: EthereumProvider): Promise<boolean> {
  const id = normalizeChainId(await ethereum.request({ method: 'eth_chainId' }))
  if (id === FUJI_CHAIN_ID) return true
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: FUJI_CHAIN_ID }],
    })
    return (
      normalizeChainId(await ethereum.request({ method: 'eth_chainId' })) ===
      FUJI_CHAIN_ID
    )
  } catch (e: unknown) {
    const code = (e as { code?: number }).code
    if (code !== 4902) return false
    try {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [FUJI_ADD_CHAIN_PARAMS],
      })
      return (
        normalizeChainId(await ethereum.request({ method: 'eth_chainId' })) ===
        FUJI_CHAIN_ID
      )
    } catch {
      return false
    }
  }
}
