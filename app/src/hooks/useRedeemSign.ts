import { useCallback, useState } from 'react'
import {
  ensureFuji,
  getEthereum,
  parseEthAddressList,
} from '../lib/ethereum'
import type { ToastType } from '../layoutOutletContext'

type ShowToast = (msg: string, type?: ToastType) => void

export type RedeemPhase = 'idle' | 'account' | 'sign'

/**
 * Redeem: 1) Fuji + `wallet_requestPermissions` (MetaMask: pick/share account)
 *         2) `personal_sign` → success/error toast.
 */
export function useRedeemSign(showToast: ShowToast) {
  const [signingId, setSigningId] = useState<string | null>(null)
  const [redeemPhase, setRedeemPhase] = useState<RedeemPhase>('idle')

  const signRedeem = useCallback(
    async (itemId: string, message: string) => {
      const ethereum = getEthereum()
      if (!ethereum) {
        showToast('MetaMask is not installed', 'error')
        return
      }

      setSigningId(itemId)
      setRedeemPhase('account')

      try {
        const okChain = await ensureFuji(ethereum)
        if (!okChain) {
          showToast(
            'Switch to Avalanche Fuji (43113) in MetaMask to redeem',
            'error'
          )
          return
        }

        showToast(
          'Redeem · step 1/2: in MetaMask confirm which account to use (pick from the list and Accept)',
          'info'
        )

        try {
          await ethereum.request({
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
          })
        } catch (permErr: unknown) {
          const pe = permErr as { code?: number; message?: string }
          if (pe.code === 4001) {
            showToast('Account selection cancelled in MetaMask', 'error')
            return
          }
          /* Wallets without wallet_requestPermissions: fall through to requestAccounts */
        }

        let accs: string[]
        try {
          accs = parseEthAddressList(
            await ethereum.request({ method: 'eth_requestAccounts' })
          )
        } catch {
          showToast('Could not get MetaMask accounts', 'error')
          return
        }

        if (accs.length === 0) {
          showToast('No connected account in MetaMask', 'error')
          return
        }

        /* Active account is usually first in MetaMask; brief delay before signing */
        await new Promise((r) => window.setTimeout(r, 300))

        setRedeemPhase('sign')
        showToast(
          'Redeem · step 2/2: sign the message in MetaMask to confirm',
          'info'
        )

        const fresh = parseEthAddressList(
          await ethereum.request({ method: 'eth_accounts' })
        )
        const from = fresh[0] ?? accs[0]
        if (!from) {
          showToast('No account selected in MetaMask', 'error')
          return
        }

        await ethereum.request({
          method: 'personal_sign',
          params: [message, from],
        })
        showToast('Redeem complete · signature recorded', 'success')
      } catch (err: unknown) {
        const e = err as { code?: number; message?: string }
        if (e?.code === 4001) {
          showToast('Signature cancelled in MetaMask', 'error')
          return
        }
        const msg = typeof e?.message === 'string' ? e.message : ''
        if (/user rejected|denied/i.test(msg)) {
          showToast('Signature cancelled in MetaMask', 'error')
        } else {
          showToast('Could not complete Redeem', 'error')
        }
      } finally {
        setSigningId(null)
        setRedeemPhase('idle')
      }
    },
    [showToast]
  )

  return { signingId, redeemPhase, signRedeem }
}
