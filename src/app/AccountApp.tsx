import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '../components/base/Button.js'
import { useSettings } from '../services/settings.js'
import { useTranslate, type TranslationKey } from '../i18n/index.js'
import { authenticate, MioError, restoreAccount, useAccount } from '../services/account.js'
import { resetChat } from '../services/chat/store.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { closeSettings } from '../components/settings/settingsDialogState.js'
import { App } from './App.js'
import styles from './AccountApp.module.css'

const authErrors: Record<string, TranslationKey> = {
  invalid: 'accountInvalid',
  bad_credentials: 'accountBadCredentials',
  invalid_invitation: 'accountInvalidInvitation',
  registration_closed: 'accountRegistrationClosed',
  username_taken: 'accountUsernameTaken',
  auth_rate: 'accountRate',
}

export const AccountApp = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const session = useAccount((state) => state.session)
  const [failed, setFailed] = useState(false)
  const load = () => {
    setFailed(false)
    void restoreAccount().catch(() => setFailed(true))
  }
  useEffect(() => {
    const unsubscribe = useAccount.subscribe((state, previous) => {
      if (state.session?.user?.context !== previous.session?.user?.context) {
        resetChat()
        stopReadAloud()
        closeSearchPanel()
        closeSettings()
      }
    })
    load()
    return unsubscribe
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  if (!session) {
    return (
      <main className={styles.page}>
        <div className={styles.panel} role="status">
          <h1>Mio Chat</h1>
          <p>{t(failed ? 'accountUnavailable' : 'sessionLoading')}</p>
          {failed ? <Button onClick={load}>{t('retry')}</Button> : null}
        </div>
      </main>
    )
  }
  if (session.user) {
    return <App key={session.user.context} />
  }
  return <AccountForm mode={session.mode} />
}

const AccountForm = ({ mode }: { mode: 'invite' | 'open' | 'closed' }) => {
  const t = useTranslate()
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey | null>(null)
  const register = registering && mode !== 'closed'
  const title = t(register ? 'accountRegister' : 'accountLogin')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    const data = new FormData(event.currentTarget)
    try {
      await authenticate(
        register,
        String(data.get('username')),
        String(data.get('password')),
        String(data.get('invitation') ?? '')
      )
    } catch (failure) {
      setError(
        failure instanceof MioError
          ? (authErrors[failure.code] ?? 'accountUnavailable')
          : 'accountUnavailable'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="account-title">
        <h1 id="account-title">Mio Chat</h1>
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label>
            {t('accountUsername')}
            <input name="username" autoComplete="username" minLength={3} maxLength={32} required />
          </label>
          <label>
            {t('accountPassword')}
            <input
              key={title}
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              minLength={10}
              maxLength={256}
              required
            />
          </label>
          {register && mode === 'invite' ? (
            <label>
              {t('accountInvitation')}
              <input name="invitation" autoComplete="off" maxLength={128} required />
            </label>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {title}
          </Button>
        </form>
        {mode !== 'closed' ? (
          <button
            className={styles.toggle}
            type="button"
            disabled={busy}
            onClick={() => {
              setRegistering(!register)
              setError(null)
            }}
          >
            {t(register ? 'accountLogin' : 'accountRegister')}
          </button>
        ) : null}
      </section>
    </main>
  )
}
