import { resolve } from 'node:path'

export const HOUR = 60 * 60 * 1000
export const MIB = 1024 * 1024

export const readConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const registration = env.REGISTRATION_MODE ?? 'invite'
  if (registration !== 'invite' && registration !== 'open' && registration !== 'closed') {
    throw new Error('REGISTRATION_MODE must be invite, open or closed')
  }
  const development = env.NODE_ENV !== 'production'
  const encryptionKey = Buffer.from(env.MIO_ENCRYPTION_KEY ?? '', 'base64')
  if (encryptionKey.length !== 32) {
    throw new Error('MIO_ENCRYPTION_KEY must contain 32 random bytes encoded as base64')
  }
  const publicOrigin = new URL(env.PUBLIC_ORIGIN ?? (development ? 'http://localhost:3000' : ''))
  if (!development && publicOrigin.protocol !== 'https:') {
    throw new Error('Production PUBLIC_ORIGIN must use HTTPS')
  }
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port')
  }
  return {
    registration,
    development,
    encryptionKey,
    port,
    origin: publicOrigin.origin,
    directory: resolve(env.MIO_DATA_DIR ?? 'data'),
    host: env.HOST ?? '127.0.0.1',
    trustProxy: env.TRUST_PROXY?.trim() || undefined,
  }
}

export type Config = ReturnType<typeof readConfig>

export class HttpError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.statusCode = status
    this.code = code
  }
}

export const invalid = (message = 'Invalid request') => new HttpError(400, 'invalid', message)
export const missing = () => new HttpError(404, 'missing', 'Resource not found')
export const conflict = () =>
  new HttpError(409, 'conflict', 'History has changed on another device')

export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid()
  }
  return value as Record<string, unknown>
}

export const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    value === '.' ||
    value === '..' ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw invalid('Invalid identifier')
  }
  return value
}
