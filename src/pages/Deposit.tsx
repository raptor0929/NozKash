import { useEffect } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { LayoutOutletContext } from '../layoutOutletContext'

/** Opens the deposit confirmation modal and returns home. */
export function Deposit() {
  const navigate = useNavigate()
  const { openDepositModal } = useOutletContext<LayoutOutletContext>()

  useEffect(() => {
    openDepositModal()
    navigate('/', { replace: true })
  }, [navigate, openDepositModal])

  return null
}
