/** Converts a decimal string like `"0.001"` or `"2"` to hex `value` (wei, 18 decimals). */
export function avaxDecimalStringToWeiHex(decStr: string): string {
  const trimmed = decStr.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${decStr}`)
  }
  const [wholeRaw, fracRaw = ''] = trimmed.split('.')
  const w = (wholeRaw.replace(/^0+(?=\d)/, '') || wholeRaw) || '0'
  const frac = (fracRaw + '0'.repeat(18)).slice(0, 18)
  const wei = BigInt(w) * 10n ** 18n + BigInt(frac || '0')
  return `0x${wei.toString(16)}`
}
