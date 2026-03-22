/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GHOST_VAULT_ADDRESS?: string
  /** 64 hex chars (32 bytes) — master seed for `deriveTokenSecrets`. */
  readonly VITE_GHOST_MASTER_SEED_HEX?: string
  /** Avalanche Fuji JSON-RPC HTTPS URL for reads (logs, blocks, receipts, estimateGas). */
  readonly VITE_FUJI_RPC_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.svg?raw' {
  const src: string
  export default src
}
