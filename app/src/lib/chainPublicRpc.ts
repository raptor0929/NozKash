/**
 * HTTP JSON-RPC for on-chain reads without the wallet (vault scans, estimates).
 *
 * URL: `VITE_PUBLIC_RPC_URL` / `VITE_ETHEREUM_RPC_URL`, or a bundled default
 * (set the URL to the same chain as `VITE_CHAIN_ID` in `ethereum.ts`).
 *
 * **429 / public RPC:** Calls are serialized and spaced (`VITE_PUBLIC_RPC_MIN_GAP_MS`,
 * default 150ms). Retries with backoff (`VITE_PUBLIC_RPC_MAX_RETRIES`, default 4).
 * Legacy `VITE_FUJI_*` env names are still read as fallbacks for migration.
 */

/** Fallback HTTPS JSON-RPC when no env URL is set (change per deployment). */
export const DEFAULT_PUBLIC_CHAIN_RPC =
  'https://ethereum-sepolia-rpc.publicnode.com'

function readRpcUrlEnv(): string | undefined {
  const a = (import.meta.env.VITE_PUBLIC_RPC_URL as string | undefined)?.trim()
  if (a) return a
  const b = (import.meta.env.VITE_ETHEREUM_RPC_URL as string | undefined)?.trim()
  if (b) return b
  const legacy = (import.meta.env.VITE_FUJI_RPC_URL as string | undefined)?.trim()
  return legacy || undefined
}

export function getChainPublicRpcUrl(): string {
  return readRpcUrlEnv() ?? DEFAULT_PUBLIC_CHAIN_RPC
}

let nextId = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function parseMaxRetries(): number {
  const raw =
    (import.meta.env.VITE_PUBLIC_RPC_MAX_RETRIES as string | undefined) ??
    (import.meta.env.VITE_FUJI_RPC_MAX_RETRIES as string | undefined)
  if (raw == null || String(raw).trim() === '') return 4
  const n = Number.parseInt(String(raw).replace(/_/g, ''), 10)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 12) : 4
}

function parseMinGapMs(): number {
  const raw =
    (import.meta.env.VITE_PUBLIC_RPC_MIN_GAP_MS as string | undefined) ??
    (import.meta.env.VITE_FUJI_RPC_MIN_GAP_MS as string | undefined)
  if (raw == null || String(raw).trim() === '') return 150
  const n = Number.parseInt(String(raw).replace(/_/g, ''), 10)
  if (!Number.isFinite(n) || n < 0) return 150
  return Math.min(n, 5000)
}

let chainRpcTail: Promise<unknown> = Promise.resolve()
let chainRpcLastEndMs = 0

function scheduleChainRpc<T>(run: () => Promise<T>): Promise<T> {
  const p = chainRpcTail.then(async () => {
    const gap = parseMinGapMs()
    if (chainRpcLastEndMs > 0 && gap > 0) {
      const wait = Math.max(0, gap - (Date.now() - chainRpcLastEndMs))
      if (wait > 0) await sleep(wait)
    }
    try {
      return await run()
    } finally {
      chainRpcLastEndMs = Date.now()
    }
  }) as Promise<T>
  chainRpcTail = p.then(
    () => undefined,
    () => undefined
  )
  return p
}

function backoffMs(attempt: number, retryAfterSec?: number | null): number {
  const base = 800 * 2 ** attempt
  const jitter = Math.floor(Math.random() * 250)
  if (retryAfterSec != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.max(base + jitter, retryAfterSec * 1000)
  }
  return base + jitter
}

function isJsonRpcRateLimitError(
  err: { message?: string; code?: number } | undefined
): boolean {
  if (!err) return false
  const code = err.code
  if (code === -32005 || code === -32016) return true
  const m = err.message ?? ''
  return /rate|limit|too many|throttl|429/i.test(m)
}

async function chainRpcCallOnce<T>(
  url: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const maxAttempts = parseMaxRetries()
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++nextId,
          method,
          params,
        }),
      })
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw lastError
    }

    if (res.status === 429 || res.status === 503) {
      const ra = res.headers.get('Retry-After')
      const sec = ra != null ? Number.parseInt(ra, 10) : NaN
      lastError = new Error(`Chain RPC HTTP ${res.status} (${url})`)
      if (attempt < maxAttempts - 1) {
        const backoff = backoffMs(
          attempt,
          Number.isFinite(sec) ? sec : undefined
        )
        await sleep(Math.max(backoff, res.status === 429 ? 2500 : 1000))
        continue
      }
      throw lastError
    }

    if (!res.ok) {
      throw new Error(`Chain RPC HTTP ${res.status} (${url})`)
    }

    let json: {
      result?: T
      error?: { message?: string; code?: number }
    }
    try {
      json = (await res.json()) as {
        result?: T
        error?: { message?: string; code?: number }
      }
    } catch {
      throw new Error(`Chain RPC invalid JSON (${url})`)
    }

    if (json.error) {
      const e = json.error
      if (isJsonRpcRateLimitError(e) && attempt < maxAttempts - 1) {
        await sleep(Math.max(backoffMs(attempt), 2000))
        continue
      }
      throw new Error(
        e.message ?? `Chain RPC error${e.code != null ? ` ${e.code}` : ''}`
      )
    }

    return json.result as T
  }

  throw lastError ?? new Error('Chain RPC failed after retries')
}

export async function chainRpcCall<T>(
  method: string,
  params: unknown[] = []
): Promise<T> {
  const url = getChainPublicRpcUrl()
  return scheduleChainRpc(() => chainRpcCallOnce<T>(url, method, params))
}
