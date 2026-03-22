/**
 * Lecturas on-chain en Fuji sin usar el RPC de MetaMask.
 *
 * **CORS:** muchos RPC públicos bloquean `fetch()` desde el navegador. En
 * `npm run dev` usamos proxy same-origin (`/fuji-rpc` → Vite). En build/preview
 * podés definir `VITE_FUJI_RPC_URL` o usar el `PUBLIC_FUJI_HTTPS_RPC` por defecto.
 */

/** RPC HTTP C-Chain Fuji (Infura) — lecturas JSON-RPC de la app. */
export const PUBLIC_FUJI_HTTPS_RPC =
  'https://avalanche-fuji.infura.io/v3/7026bb4d4e424828bfb0824e61bde166'

export function getFujiRpcUrl(): string {
  const raw = import.meta.env.VITE_FUJI_RPC_URL as string | undefined
  const u = raw?.trim()
  if (u && u.length > 0) return u
  if (import.meta.env.DEV) {
    return `${typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : ''}/fuji-rpc`
  }
  return PUBLIC_FUJI_HTTPS_RPC
}

let nextId = 0

export async function fujiRpcCall<T>(
  method: string,
  params: unknown[] = []
): Promise<T> {
  const url = getFujiRpcUrl()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++nextId,
      method,
      params,
    }),
  })
  if (!res.ok) {
    throw new Error(`Fuji RPC HTTP ${res.status} (${url})`)
  }
  const json = (await res.json()) as {
    result?: T
    error?: { message?: string; code?: number }
  }
  if (json.error) {
    throw new Error(
      json.error.message ?? `Fuji RPC error${json.error.code != null ? ` ${json.error.code}` : ''}`
    )
  }
  return json.result as T
}
