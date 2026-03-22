/** Context passed from `Layout` via `<Outlet context={...} />`. */
export type ToastType = 'success' | 'error' | 'info'

export type LayoutOutletContext = {
  openDepositModal: () => void
  showToast: (msg: string, type?: ToastType) => void
}
