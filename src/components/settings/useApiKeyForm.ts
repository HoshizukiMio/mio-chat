import { useState } from 'react'
import { MioError, saveApiKey } from '../../services/account.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : cause instanceof MioError && cause.code === 'invalid_key'
        ? t('apiKeyInvalid')
        : cause instanceof TypeError
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message: cause instanceof Error ? cause.message : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await saveApiKey(apiKey)
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  const remove = async () => {
    if (verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await saveApiKey(null)
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit, remove }
}
