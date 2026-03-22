import { useId, useRef } from 'react'
import { formatIsoToPillDay } from '../lib/dateRangeFormat'

function openNativeDatePicker(el: HTMLInputElement | null) {
  if (!el) return
  try {
    el.showPicker()
  } catch {
    el.click()
  }
}

export type DateRangePillProps = {
  dateFrom: string
  dateTo: string
  onDateFromChange: (value: string) => void
  onDateToChange: (value: string) => void
  onClear: () => void
  className?: string
}

export function DateRangePill({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  onClear,
  className,
}: DateRangePillProps) {
  const uid = useId()
  const fromRef = useRef<HTMLInputElement>(null)
  const toRef = useRef<HTMLInputElement>(null)

  const fromLabel = formatIsoToPillDay(dateFrom)
  const toLabel = formatIsoToPillDay(dateTo)

  return (
    <div
      className={
        className ? `date-range-pill ${className}` : 'date-range-pill'
      }
    >
      <div className="date-range-pill-track">
        <button
          type="button"
          className={`date-pill-seg${dateFrom ? ' date-pill-seg--on' : ''}`}
          onClick={() => openNativeDatePicker(fromRef.current)}
        >
          <span className="date-pill-seg-inner">
            <span className="date-pill-prefix">FROM </span>
            <span className="date-pill-val">{fromLabel || '—'}</span>
          </span>
        </button>
        <span className="date-range-pill-dash" aria-hidden>
          –
        </span>
        <button
          type="button"
          className={`date-pill-seg${dateTo ? ' date-pill-seg--on' : ''}`}
          onClick={() => openNativeDatePicker(toRef.current)}
        >
          <span className="date-pill-seg-inner">
            <span className="date-pill-prefix">TO </span>
            <span className="date-pill-val">{toLabel || '—'}</span>
          </span>
        </button>
        <button
          type="button"
          className="date-range-pill-clear"
          aria-label="Clear dates"
          onClick={onClear}
        >
          ×
        </button>
      </div>
      <input
        ref={fromRef}
        id={`${uid}-from`}
        className="date-range-pill-input"
        type="date"
        value={dateFrom}
        onChange={(e) => onDateFromChange(e.target.value)}
        aria-label="Date from"
      />
      <input
        ref={toRef}
        id={`${uid}-to`}
        className="date-range-pill-input"
        type="date"
        value={dateTo}
        onChange={(e) => onDateToChange(e.target.value)}
        aria-label="Date to"
      />
    </div>
  )
}
