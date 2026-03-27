import {
  buildGhostVaultRedeemCalldata,
  clearRedemptionDraft,
  redemptionDraftMatchesSecrets,
  type RedemptionDraftV1,
} from '../crypto/ghostRedeem'
import {
  ensureTargetChain,
  targetChainMismatchUserMessage,
  waitForTransactionReceipt,
} from './ethereum'
import { chainRpcCall } from './chainPublicRpc'
import {
  fetchMintFulfilledSPrime,
  GHOST_VAULT_ADDRESS,
  requestVaultActivityRefresh,
} from './ghostVault'

export type EthereumRequester = {
  request: (args: {
    method: string
    params?: unknown[]
  }) => Promise<unknown>
}

/**
 * Sends `GhostVault.redeem` using the local draft (spend/blind keys) and `recipient`.
 * Clears the draft and invalidates activity cache on success.
 */
function redeemDebug(msg: string, data?: Record<string, unknown>) {
  const on =
    import.meta.env.DEV ||
    import.meta.env.VITE_GHOST_REDEEM_DEBUG === 'true'
  if (!on) return
  console.log('[GhostVault redeem]', msg, data ?? '')
}

function encodeUint256Arg(n: number): `0x${string}` {
  const hex = BigInt(n).toString(16).padStart(64, '0')
  return (`0x${hex}`) as `0x${string}`
}

export async function sendVaultRedeemTransaction(params: {
  ethereum: EthereumRequester
  recipient: string
  draft: RedemptionDraftV1
  /**
   * When `masterSeed` is present, alignment is checked **only** if the account
   * signing the tx is the same as the one that prepared the draft (Account 1).
   * If another account (Account 2) sends the tx, the in-memory seed differs — the
   * draft already carries spend/blind in localStorage and is not validated against `masterSeed`.
   */
  masterSeed?: Uint8Array | null
}): Promise<{ txHash: string }> {
  const { ethereum, recipient, draft, masterSeed } = params
  const r = recipient.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(r)) {
    throw new Error('Invalid recipient address')
  }

  const recipientLc = r.toLowerCase()
  const prepareLc = draft.prepareAccount?.toLowerCase()
  const isExecutorAccount =
    draft.prepareAccount != null && recipientLc !== prepareLc

  redeemDebug('pre-check', {
    recipient: recipientLc,
    prepareAccount: prepareLc ?? '(none)',
    isExecutorAccount,
    hasMasterSeed: Boolean(masterSeed?.length),
  })
  redeemDebug('draft', {
    tokenIndex: draft.tokenIndex,
    depositId: draft.depositId.toLowerCase(),
    nullifier: draft.spendAddress.toLowerCase(),
    savedAtMs: draft.savedAt,
  })

  if (masterSeed && !isExecutorAccount) {
    const ok = redemptionDraftMatchesSecrets(draft, masterSeed)
    redeemDebug('redemptionDraftMatchesSecrets', { ok })
    if (!ok) {
      throw new Error('Redeem draft does not match current vault seed')
    }
  } else if (isExecutorAccount) {
    redeemDebug(
      'skip seed check (executor account; draft keys are self-contained)'
    )
  }

  const okChain = await ensureTargetChain(ethereum)
  if (!okChain) {
    throw new Error(targetChainMismatchUserMessage())
  }

  const mint = await fetchMintFulfilledSPrime(draft.depositId, {
    contractAddress: GHOST_VAULT_ADDRESS,
  })
  if (!mint) {
    throw new Error('No MintFulfilled log for this depositId')
  }
  try {
    // `uint256[4] public pkMint` generates getter: pkMint(uint256) -> uint256
    // selector: keccak256("pkMint(uint256)")[:4] = 0x14f2a9c2
    const selector = '0x14f2a9c2'
    const limbs: string[] = []
    for (let i = 0; i < 4; i++) {
      const limbHex = await chainRpcCall<string>('eth_call', [
        {
          to: GHOST_VAULT_ADDRESS,
          data: `${selector}${encodeUint256Arg(i).slice(2)}`,
        },
        'latest',
      ])
      limbs.push(limbHex)
    }
    redeemDebug('contract pkMint limbs', {
      pkMint0: limbs[0],
      pkMint1: limbs[1],
      pkMint2: limbs[2],
      pkMint3: limbs[3],
    })
  } catch (e) {
    redeemDebug('contract pkMint eth_call failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
  redeemDebug('mint log found', {
    tokenIndex: draft.tokenIndex,
    depositId: draft.depositId.toLowerCase(),
    sx: mint.sx.toString(10),
    sy: mint.sy.toString(10),
  })

  const data = await buildGhostVaultRedeemCalldata({
    draft,
    recipient: r,
    mintFulfilled: mint,
  })
  redeemDebug('calldata built', {
    tokenIndex: draft.tokenIndex,
    selector: data.slice(0, 10).toLowerCase(),
    bytes: Math.max(0, (data.length - 2) / 2),
  })

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

  /* Prefer wallet RPC for receipt polling so Infura isn’t hit during the same redeem flow as `fetchMintFulfilledSPrime` + vault refresh. */
  const receipt = await waitForTransactionReceipt(hash, { ethereum })
  if (receipt.status === '0x0') {
    throw new Error('Transaction reverted')
  }

  clearRedemptionDraft()
  requestVaultActivityRefresh()
  return { txHash: hash }
}
