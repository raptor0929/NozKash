const SHORT = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

/** ISO `YYYY-MM-DD` → `19 MAR` (case as returned; CSS applies uppercase). */
export function formatIsoToPillDay(iso: string): string {
  const parts = iso.split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const date = new Date(y, m - 1, d)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getDate()} ${SHORT[date.getMonth()]}`
}
