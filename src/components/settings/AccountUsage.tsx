import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadAccountUsage } from '../../services/chat/db.js'
import type { AccountUsage as Usage } from '../../services/chat/usage.js'
import { Button } from '../base/Button.js'
import { UsageCard } from '../messages/TokenUsage.js'
import styles from '../messages/TokenUsage.module.css'

export const AccountUsage = () => {
  const t = useTranslate()
  const [data, setData] = useState<Usage | 'error' | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadAccountUsage(controller.signal).then(
      (usage) => {
        if (!controller.signal.aborted) {
          setData(usage)
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setData('error')
        }
      }
    )
    return () => controller.abort()
  }, [retry])
  return (
    <div className={styles.account} aria-live="polite">
      {data === 'error' ? (
        <p>
          {t('tokenUsageFailed')}{' '}
          <Button
            size="s"
            variant="outlined"
            onClick={() => {
              setData(null)
              setRetry((n) => n + 1)
            }}
          >
            {t('retry')}
          </Button>
        </p>
      ) : data ? (
        <>
          <UsageCard usage={data.usage} title={t('tokenAccountUsage')} replies={data.replies} />
          <p>{t('tokenUsageScope')}</p>
        </>
      ) : (
        <p>{t('tokenUsageLoading')}</p>
      )}
    </div>
  )
}
