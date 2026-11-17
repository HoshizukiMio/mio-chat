import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { searchSessions } from '../../services/chat/db.js'
import { selectSearchResult, useChatStore } from '../../services/chat/store.js'
import type { SessionSearchResult } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

type SearchState =
  | { query: string; results: SessionSearchResult[]; more: boolean }
  | { query: string; error: true }

export const SessionSearch = ({ compact = false }: { compact?: boolean }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const locked = useChatStore((state) => !state.ready || state.importingHistory)
  const label = t('sessionSearch')
  return (
    <>
      {compact ? (
        <IconButton
          size="m"
          icon={<IconSearchOutline16 />}
          tooltip={label}
          disabled={locked}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button
          size="s"
          variant="outlined"
          block
          className={styles.trigger}
          disabled={locked}
          onClick={() => setOpen(true)}
        >
          <IconSearchOutline16 /> {label}
        </Button>
      )}
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const SearchDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [input, setInput] = useState('')
  const [composing, setComposing] = useState(false)
  const [state, setState] = useState<SearchState | null>(null)
  const [retry, setRetry] = useState(0)
  const query = composing ? '' : input.trim()
  const result = state?.query === query ? state : null
  useEffect(() => {
    if (!query) {
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void searchSessions(query, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted) {
            setState({ query, ...data })
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setState({ query, error: true })
          }
        }
      )
    }, 240)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, retry])
  return (
    <Modal title={t('sessionSearch')} closable className={styles.dialog} onClose={onClose}>
      <div className={styles.field}>
        <IconSearchOutline16 />
        <input
          type="search"
          aria-label={t('sessionSearch')}
          placeholder={t('sessionSearchPlaceholder')}
          maxLength={200}
          autoFocus
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </div>
      {query ? (
        <div className={styles.results} aria-live="polite">
          {!result ? (
            <p>{t('sessionSearchLoading')}</p>
          ) : 'error' in result ? (
            <p>
              {t('sessionSearchFailed')}{' '}
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  setState(null)
                  setRetry((n) => n + 1)
                }}
              >
                {t('retry')}
              </Button>
            </p>
          ) : result.results.length === 0 ? (
            <p>{t('sessionSearchEmpty')}</p>
          ) : (
            <>
              {result.results.map((item) => (
                <button
                  key={item.session.id}
                  type="button"
                  className={styles.result}
                  onClick={() => {
                    void selectSearchResult(item)
                    onClose()
                    closeMobileSider()
                  }}
                >
                  <span>{item.session.title || t('untitledChat')}</span>
                  {item.snippet ? <small>{item.snippet}</small> : null}
                </button>
              ))}
              {result.more ? <p>{t('sessionSearchMore')}</p> : null}
            </>
          )}
        </div>
      ) : null}
    </Modal>
  )
}
