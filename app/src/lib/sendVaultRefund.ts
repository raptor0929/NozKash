import {
  ensureTargetChain,
  targetChainMismatchUserMessage,
  waitForTransactionReceipt,
} from './ethereum'
import { chainRpcCall } from './chainPublicRpc'
import {
  GHOST_VAULT_ADDRESS,
  requestVaultActivityRefresh,
} from './ghostVault'

export type EthereumRequester = {
  request: (args: {
    method: string
    params?: unknown[]
  }) => Promise<unknown>
}

/** First 4 bytes of `keccak256("refund(address)")`. */
const REFUND_SELECTOR = '0xfa89401a'

function encodeAddress32(depositId: string): string {
  const h = depositId.replace(/^0x/i, '').toLowerCase()
  if (h.length !== 40) throw new Error(`Invalid depositId: ${depositId}`)
  return h.padStart(64, '0')
}

export function encodeGhostVaultRefundCalldata(depositId: string): `0x${string}` {
  return `${REFUND_SELECTOR}${encodeAddress32(depositId)}` as `0x${string}`
}

/**
 * Sends `GhostVault.refund(depositId)` from the connected wallet (must be the original depositor).
 */
export async function sendVaultRefundTransaction(params: {
  ethereum: EthereumRequester
  depositId: string
}): Promise<{ txHash: string }> {
  const { ethereum, depositId } = params
  const id = depositId.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(id)) {
    throw new Error('Invalid depositId')
  }

  const okChain = await ensureTargetChain(ethereum)
  if (!okChain) {
    throw new Error(targetChainMismatchUserMessage())
  }

  const data = encodeGhostVaultRefundCalldata(id)

  const accs = (await ethereum.request({
    method: 'eth_requestAccounts',
  })) as unknown
  const from =
    Array.isArray(accs) && typeof accs[0] === 'string' ? accs[0] : null
  if (!from) {
    throw new Error('No connected account')
  }

  const sendParams = {
    from,
    to: GHOST_VAULT_ADDRESS,
    data,
    value: '0x0',
  }

  try {
    await chainRpcCall('eth_call', [sendParams, 'latest'])
  } catch {
    /* optional simulation */
  }

  const hash = (await ethereum.request({
    method: 'eth_sendTransaction',
    params: [sendParams],
  })) as string

  const receipt = await waitForTransactionReceipt(hash, { ethereum })
  if (receipt.status === '0x0') {
    throw new Error('Transaction reverted')
  }

  requestVaultActivityRefresh()
  return { txHash: hash }
}
