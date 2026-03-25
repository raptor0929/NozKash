/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GHOST_VAULT_ADDRESS?: string
  /** 64 hex chars (32 bytes) — master seed for `deriveTokenSecrets`. */
  readonly VITE_GHOST_MASTER_SEED_HEX?: string
  /** Avalanche Fuji JSON-RPC HTTPS URL for reads (logs, blocks, receipts, estimateGas). */
  readonly VITE_FUJI_RPC_URL?: string
  /** Avalanche Fuji WebSocket endpoint for `eth_subscribe` logs (optional). */
  readonly VITE_FUJI_WS_RPC_URL?: string
  /** Max retries for HTTP 429/503 and JSON-RPC rate limits (default 4). */
  readonly VITE_FUJI_RPC_MAX_RETRIES?: string
  /**
   * Min ms between consecutive HTTP JSON-RPC requests (global serial queue). Default 150.
   * Set `0` for high-throughput paid RPC.
   */
  readonly VITE_FUJI_RPC_MIN_GAP_MS?: string
  /** Dashboard / Redeem / deposit modal: vault activity poll interval in ms (default 10000, min 2000). */
  readonly VITE_GHOST_VAULT_RPC_POLL_MS?: string
  /** Max consecutive JSON-RPC calls before pausing vault scan (default 5). */
  readonly VITE_GHOST_VAULT_RPC_BURST?: string
  /** Pause in ms after burst is exhausted (default 7500). */
  readonly VITE_GHOST_VAULT_RPC_PAUSE_MS?: string
  /** Vault activity cache TTL in ms (default 60000). 0 = no cache. */
  readonly VITE_GHOST_VAULT_SCAN_CACHE_MS?: string
  /** Token indices per scan batch (default 5). */
  readonly VITE_GHOST_VAULT_TOKEN_BATCH_SIZE?: string
  /**
   * Max batches for vault activity + next token index scan (default 128; max 10000).
   * Max token index ≈ `this × 5 - 1` when scans run to the cap.
   */
  readonly VITE_GHOST_VAULT_MAX_BATCHES?: string
  /** Optional: only this account sees "Start redeem" before the first draft (same as Account 1). */
  readonly VITE_GHOST_REDEEM_PREPARE_ACCOUNT?: string
  /** Optional: only this account sees "Redeem here" (Account 2 / who signs the tx). */
  readonly VITE_GHOST_REDEEM_EXECUTOR_ACCOUNT?: string
  /** `true` — log `[GhostVault redeem]` to console (in addition to `import.meta.env.DEV`). */
  readonly VITE_GHOST_REDEEM_DEBUG?: string
  /** `true` — log `[GhostVault activity]` (vault scan / cache); also on in `import.meta.env.DEV`. */
  readonly VITE_GHOST_VAULT_ACTIVITY_DEBUG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.svg?raw' {
  const src: string
  export default src
}
