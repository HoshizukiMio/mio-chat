import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { inputTokens, totalTokens, type TokenUsage as Counts } from '../../services/chat/usage.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import styles from './TokenUsage.module.css'

const TokenIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <ellipse cx="8" cy="4.2" rx="5.2" ry="2.3" />
    <path d="M2.8 4.2v7.5C2.8 13 5.1 14 8 14s5.2-1 5.2-2.3V4.2M2.8 8C2.8 9.3 5.1 10.3 8 10.3s5.2-1 5.2-2.3" />
  </svg>
)

export const UsageCard = ({
  usage,
  title,
  model,
  replies,
}: {
  usage: Counts
  title: string
  model?: string | null
  replies?: number
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const number = new Intl.NumberFormat(locale)
  const format = (value: number) => `${number.format(value)} tok`
  const input = inputTokens(usage)
  const cacheHit = input
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
        usage.cache_read_input_tokens / input
      )
    : '—'
  const rows = [
    ...(model !== undefined
      ? [[t('tokenProviderModel'), model ? `deepseek-official/${model}` : '—']]
      : []),
    ...(replies !== undefined ? [[t('tokenRecordedReplies'), number.format(replies)]] : []),
    [t('tokenCacheHit'), cacheHit],
    [t('tokenUncachedInput'), format(usage.input_tokens)],
    [t('tokenCacheRead'), format(usage.cache_read_input_tokens)],
    [t('tokenCacheWrite'), format(usage.cache_creation_input_tokens)],
    [t('tokenOutput'), format(usage.output_tokens)],
  ]
  return (
    <div className={styles.card}>
      <div className={styles.heading}>
        <span>
          <TokenIcon /> {title}
        </span>
        <strong>{format(totalTokens(usage))}</strong>
      </div>
      <dl className={styles.rows}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.row}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export const TokenUsage = ({
  usage,
  model,
  timestamp,
}: {
  usage: Counts
  model: string | null
  timestamp: number
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 7,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })
  const compact = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(totalTokens(usage))
  const date = new Date(timestamp)
  return (
    <div className={styles.meta}>
      <button
        ref={anchorRef}
        type="button"
        className={styles.chip}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        <TokenIcon />
        {t('tokenUsageChip', { total: compact })}
      </button>
      {Number.isFinite(date.getTime()) ? (
        <time dateTime={date.toISOString()}>
          {new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(date)}
        </time>
      ) : null}
      {open
        ? createPortal(
            <div
              id={panelId}
              ref={floatingRef}
              className={styles.popup}
              style={position ?? { visibility: 'hidden' }}
            >
              <UsageCard usage={usage} model={model} title={t('tokenRoundUsage')} />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
