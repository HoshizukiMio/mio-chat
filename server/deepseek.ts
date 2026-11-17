import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { RequireAccount } from './auth.ts'
import { HttpError, MIB, invalid, object, type Config } from './config.ts'
import { transaction, type Database } from './database.ts'

const upstream = 'https://api.deepseek.com'
type UpstreamFetch = typeof fetch
const fileReference = (value: unknown) => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const block = value as { source?: { type?: string; file_id?: string } }
  return block.source?.type === 'file' ? block.source.file_id : null
}

export const registerDeepSeek = (
  app: FastifyInstance,
  db: Database,
  config: Config,
  account: RequireAccount,
  upstreamFetch: UpstreamFetch
) => {
  const seal = (user: string, key: string) => {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, nonce)
    cipher.setAAD(Buffer.from(user))
    return Buffer.concat([
      nonce,
      cipher.update(key, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64')
  }
  const unseal = (user: string, value: string) => {
    const bytes = Buffer.from(value, 'base64')
    const cipher = createDecipheriv('aes-256-gcm', config.encryptionKey, bytes.subarray(0, 12))
    cipher.setAAD(Buffer.from(user))
    cipher.setAuthTag(bytes.subarray(-16))
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8')
  }
  app.put('/api/account/api-key', { bodyLimit: 4096 }, async (request, reply) => {
    const user = account(request, reply)
    const apiKey = object(request.body).apiKey
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(apiKey)) {
      throw invalid('Invalid API Key')
    }
    const response = await upstreamFetch(`${upstream}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new HttpError(502, 'upstream_unavailable', 'Unable to reach DeepSeek')
    })
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(401, 'invalid_key', 'Invalid DeepSeek API Key')
    }
    if (!response.ok) {
      throw new HttpError(502, 'key_validation', 'DeepSeek could not validate this API Key')
    }
    account(request, reply)
    transaction(db, () => {
      db.prepare('UPDATE users SET api_key=?, key_version=key_version+1 WHERE id=?').run(
        seal(user.id, apiKey),
        user.id
      )
      db.prepare('DELETE FROM provider_files WHERE user_id=?').run(user.id)
    })
    return { hasApiKey: true }
  })
  app.delete('/api/account/api-key', (request, reply) => {
    const user = account(request, reply)
    transaction(db, () => {
      db.prepare('UPDATE users SET api_key=NULL, key_version=key_version+1 WHERE id=?').run(user.id)
      db.prepare('DELETE FROM provider_files WHERE user_id=?').run(user.id)
    })
    return { hasApiKey: false }
  })

  const uploads = db.prepare('INSERT OR REPLACE INTO provider_files VALUES (?, ?, ?)')
  const hasFile = db.prepare(
    'SELECT 1 FROM provider_files WHERE user_id=? AND id=? AND key_version=?'
  )
  const active = new Map<string, number>()
  const routes = [
    ['/anthropic/v1/messages', 32 * MIB, 'json'],
    ['/anthropic/v1/files', 65 * MIB, 'multipart'],
    ['/v1/tools/asr', 9 * MIB, 'multipart'],
    ['/v1/tools/tts', 4 * MIB, 'json'],
  ] as const
  for (const [path, maxSize, kind] of routes) {
    app.post(`/api/deepseek${path}`, { bodyLimit: maxSize }, async (request, reply) => {
      const user = account(request, reply)
      if (!user.api_key) {
        throw new HttpError(401, 'missing_key', 'Configure a DeepSeek API Key')
      }
      const key = unseal(user.id, user.api_key)
      const headers = new Headers()
      if (path.startsWith('/anthropic/')) {
        headers.set('x-api-key', key)
        headers.set('anthropic-version', '2023-06-01')
        if (
          path.endsWith('/files') ||
          request.headers['anthropic-beta'] === 'files-api-2025-04-14'
        ) {
          headers.set('anthropic-beta', 'files-api-2025-04-14')
        }
      } else {
        headers.set('authorization', `Bearer ${key}`)
      }
      const contentType = request.headers['content-type'] ?? ''
      const controller = new AbortController()
      const chronometer = AbortSignal.timeout(15 * 60_000)
      let tooLarge = false
      let body: string | Readable
      if (kind === 'json') {
        const data = object(request.body)
        if (path.endsWith('/messages')) {
          if (!Array.isArray(data.messages)) {
            throw invalid('Expected messages')
          }
          const refs = data.messages.flatMap((message: unknown) => {
            const content = object(message).content
            return Array.isArray(content) ? content.map(fileReference) : []
          })
          if (
            refs.some(
              (id) =>
                id != null &&
                (typeof id !== 'string' || !hasFile.get(user.id, id, user.key_version))
            )
          ) {
            throw invalid('file_ids do not exist or are not created under your account')
          }
          data.safety_check = { level: 'high' }
          data.stream = true
          headers.set('accept', 'text/event-stream')
        }
        headers.set('content-type', 'application/json')
        body = JSON.stringify(data)
      } else {
        const stream = request.body as Readable
        if (!contentType.startsWith('multipart/form-data;') || typeof stream?.pipe !== 'function') {
          throw invalid('Expected multipart form data')
        }
        if (Number(request.headers['content-length']) > maxSize) {
          throw new HttpError(413, 'file_size', 'Request is too large')
        }
        headers.set('content-type', contentType)
        body = Readable.from(
          (async function* () {
            let bytes = 0
            for await (const chunk of stream) {
              bytes += (chunk as Buffer).length
              if (bytes > maxSize) {
                tooLarge = true
                controller.abort()
                return
              }
              yield chunk
            }
          })()
        )
      }
      const count = active.get(user.id) ?? 0
      if (count >= 8) {
        throw new HttpError(429, 'proxy_limit', 'Too many DeepSeek requests')
      }
      active.set(user.id, count + 1)
      const release = () => {
        reply.raw.off('finish', release)
        reply.raw.off('close', release)
        controller.abort()
        const left = (active.get(user.id) ?? 1) - 1
        if (left) {
          active.set(user.id, left)
        } else {
          active.delete(user.id)
        }
      }
      reply.raw.once('finish', release)
      reply.raw.once('close', release)
      const response = await upstreamFetch(`${upstream}${path}`, {
        method: 'POST',
        headers,
        body: body as BodyInit,
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, chronometer]),
      } as RequestInit).catch(() => {
        if (tooLarge) {
          throw new HttpError(413, 'file_size', 'Request is too large')
        }
        throw new HttpError(502, 'upstream_unavailable', 'Unable to reach DeepSeek')
      })
      void reply
        .code(response.status)
        .type(response.headers.get('content-type') ?? 'application/octet-stream')
      if (path.endsWith('/files') && response.ok) {
        const file = object(await response.json())
        if (typeof file.id !== 'string') {
          throw new HttpError(502, 'upstream_protocol', 'DeepSeek did not return a file ID')
        }
        const latest = account(request, reply)
        if (latest.key_version !== user.key_version) {
          throw new HttpError(409, 'key_changed', 'DeepSeek API Key changed during upload')
        }
        uploads.run(user.id, file.id, user.key_version)
        return reply.send(file)
      }
      if (!response.ok) {
        return reply.send((await response.text()).replaceAll(key, '[redacted]'))
      }
      if (path.endsWith('/messages')) {
        void reply.header('x-accel-buffering', 'no')
      }
      return reply.send(response.body ? Readable.fromWeb(response.body as never) : undefined)
    })
  }
}
