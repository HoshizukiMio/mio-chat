import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HOUR, HttpError, invalid, object, type Config } from './config.ts'
import { transaction, type Database } from './database.ts'

const deriveKey = promisify(scrypt)
const loginAge = 30 * 24 * HOUR
const rateWindow = 15 * 60 * 1000
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const randomToken = () => randomBytes(32).toString('base64url')

export const issueInvitation = (db: Database, hours = 7 * 24) => {
  const token = randomToken()
  db.prepare('INSERT INTO invitations VALUES (?, ?)').run(
    tokenHash(token),
    Date.now() + hours * HOUR
  )
  return token
}

type Account = {
  id: string
  username: string
  api_key: string | null
  key_version: number
  context: string
  token: string
}

export const registerAuth = (app: FastifyInstance, db: Database, config: Config) => {
  const cookie = config.development ? 'mio_session' : '__Host-mio_session'
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !config.development,
    path: '/',
  }
  const findAccount = (request: FastifyRequest) => {
    const raw = request.cookies[cookie]
    if (!raw) {
      return undefined
    }
    return db
      .prepare(`
      SELECT u.id, u.username, u.api_key, u.key_version, l.context, l.token
      FROM logins l JOIN users u ON u.id = l.user_id WHERE l.token = ? AND l.expires > ?
    `)
      .get(tokenHash(raw), Date.now()) as Account | undefined
  }
  const account = (request: FastifyRequest, reply: FastifyReply) => {
    const found = findAccount(request)
    if (!found || request.headers['x-mio-session'] !== found.context) {
      void reply.header('x-mio-auth-required', '1')
      throw new HttpError(401, 'auth_required', 'Sign in to continue')
    }
    return found
  }
  const publicAccount = (found: Pick<Account, 'id' | 'username' | 'context' | 'api_key'>) => ({
    id: found.id,
    username: found.username,
    context: found.context,
    hasApiKey: !!found.api_key,
  })
  const startLogin = (
    request: FastifyRequest,
    reply: FastifyReply,
    user: { id: string; username: string; api_key: string | null }
  ) => {
    const token = randomToken()
    const context = randomUUID()
    transaction(db, () => {
      const previous = request.cookies[cookie]
      if (previous) {
        db.prepare('DELETE FROM logins WHERE token = ?').run(tokenHash(previous))
      }
      db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)').run(
        tokenHash(token),
        context,
        user.id,
        Date.now() + loginAge
      )
    })
    void reply.setCookie(cookie, token, { ...cookieOptions, maxAge: loginAge / 1000 })
    return { mode: config.registration, user: publicAccount({ ...user, context }) }
  }
  const enforceRate = (ip: string, username: string) => {
    const now = Date.now()
    const bump = db.prepare(`
      INSERT INTO auth_limits VALUES (?, 1, ?) ON CONFLICT(scope) DO UPDATE SET
        count = CASE WHEN expires <= ? THEN 1 ELSE count + 1 END,
        expires = CASE WHEN expires <= ? THEN excluded.expires ELSE expires END
      RETURNING count
    `)
    const hit = (scope: string) => Number(bump.get(scope, now + rateWindow, now, now)?.count)
    const allowed = transaction(db, () => {
      return (
        hit(`ip:${ip}`) <= 30 && hit(`pair:${ip}:${username}`) <= 8 && hit(`name:${username}`) <= 20
      )
    })
    if (!allowed) {
      throw new HttpError(429, 'auth_rate', 'Too many attempts. Try again later.')
    }
  }
  const credentials = (request: FastifyRequest) => {
    const body = object(request.body)
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = body.password
    if (
      !/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(username) ||
      typeof password !== 'string' ||
      password.length < 10 ||
      Buffer.byteLength(password) > 256
    ) {
      throw invalid('Use a 3–32 character username and a 10–256 byte password')
    }
    enforceRate(request.ip, username)
    return { username, password, invitation: body.invitation }
  }

  app.get('/api/auth/session', (request) => {
    const found = findAccount(request)
    return { mode: config.registration, user: found ? publicAccount(found) : null }
  })
  app.post('/api/auth/register', { bodyLimit: 4096 }, async (request, reply) => {
    if (config.registration === 'closed') {
      throw new HttpError(403, 'registration_closed', 'Registration is closed')
    }
    const { username, password, invitation } = credentials(request)
    const inviteHash =
      typeof invitation === 'string' && invitation.length <= 128 ? tokenHash(invitation.trim()) : ''
    const salt = randomBytes(16).toString('hex')
    const hash = ((await deriveKey(password, salt, 64)) as Buffer).toString('hex')
    const id = randomUUID()
    transaction(db, () => {
      if (
        config.registration === 'invite' &&
        !db
          .prepare('DELETE FROM invitations WHERE hash = ? AND expires > ?')
          .run(inviteHash, Date.now()).changes
      ) {
        throw new HttpError(403, 'invalid_invitation', 'Invitation is invalid or has expired')
      }
      if (
        !db
          .prepare('INSERT OR IGNORE INTO users (id, username, password) VALUES (?, ?, ?)')
          .run(id, username, `${salt}:${hash}`).changes
      ) {
        throw new HttpError(409, 'username_taken', 'Username is already in use')
      }
    })
    void reply.code(201)
    return startLogin(request, reply, { id, username, api_key: null })
  })
  app.post('/api/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const { username, password } = credentials(request)
    const user = db
      .prepare('SELECT id, username, password, api_key FROM users WHERE username = ?')
      .get(username) as
      | { id: string; username: string; password: string; api_key: string | null }
      | undefined
    const [salt, expected] = (user?.password ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
    const actual = (await deriveKey(password, salt, 64)) as Buffer
    if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || !user) {
      throw new HttpError(401, 'bad_credentials', 'Incorrect username or password')
    }
    return startLogin(request, reply, user)
  })
  app.post('/api/auth/logout', (request, reply) => {
    const found = account(request, reply)
    db.prepare('DELETE FROM logins WHERE token = ?').run(found.token)
    return reply.clearCookie(cookie, cookieOptions).code(204).send()
  })
  return account
}

export type RequireAccount = ReturnType<typeof registerAuth>
