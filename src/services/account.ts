import { create } from 'zustand'

type RegistrationMode = 'invite' | 'open' | 'closed'
type User = { id: string; username: string; context: string; hasApiKey: boolean }
type Session = { mode: RegistrationMode; user: User | null }

export const useAccount = create<{ session: Session | null }>(() => ({ session: null }))
let lifetime = new AbortController()
const setSession = (session: Session) => {
  if (useAccount.getState().session?.user?.context !== session.user?.context) {
    lifetime.abort()
    lifetime = new AbortController()
  }
  useAccount.setState({ session })
}

export const mioFetch = async (path: string, init: RequestInit = {}, authenticated = true) => {
  const headers = new Headers(init.headers)
  headers.set('x-mio-request', '1')
  const session = useAccount.getState().session
  const context = session?.user?.context
  if (authenticated) {
    if (!context) {
      throw new DOMException('Sign in to continue', 'AbortError')
    }
    headers.set('x-mio-session', context)
  }
  const signal =
    authenticated && init.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([lifetime.signal, init.signal])
      : (init.signal ?? (authenticated ? lifetime.signal : undefined))
  const response = await fetch(path, { ...init, headers, signal, credentials: 'same-origin' })
  if (
    authenticated &&
    response.headers.has('x-mio-auth-required') &&
    useAccount.getState().session?.user?.context === context
  ) {
    setSession({ mode: session?.mode ?? 'closed', user: null })
  }
  return response
}

export class MioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MioError'
  }
}

export const checkResponse = async (response: Response) => {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    throw new MioError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? response.statusText
    )
  }
  return response
}

export const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

export const restoreAccount = async () => {
  const response = await checkResponse(await mioFetch('/api/auth/session', {}, false))
  setSession((await response.json()) as Session)
}

export const authenticate = async (
  register: boolean,
  username: string,
  password: string,
  invitation: string
) => {
  const response = await checkResponse(
    await mioFetch(
      register ? '/api/auth/register' : '/api/auth/login',
      jsonRequest('POST', { username, password, invitation }),
      false
    )
  )
  setSession((await response.json()) as Session)
}

export const logout = async () => {
  const session = useAccount.getState().session
  if (!session?.user) {
    return
  }
  const response = await mioFetch('/api/auth/logout', { method: 'POST' })
  if (response.status !== 401) {
    await checkResponse(response)
  }
  if (useAccount.getState().session?.user?.context === session.user.context) {
    setSession({ mode: session.mode, user: null })
  }
}

export const saveApiKey = async (apiKey: string | null) => {
  const session = useAccount.getState().session
  if (!session?.user) {
    return
  }
  const response = await checkResponse(
    await mioFetch(
      '/api/account/api-key',
      apiKey === null ? { method: 'DELETE' } : jsonRequest('PUT', { apiKey })
    )
  )
  const data = (await response.json()) as Pick<User, 'hasApiKey'>
  if (useAccount.getState().session?.user?.context === session.user.context) {
    setSession({ ...session, user: { ...session.user, ...data } })
  }
}
