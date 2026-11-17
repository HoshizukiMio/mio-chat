import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { HOUR, MIB, HttpError, conflict, identifier, invalid, missing } from './config.ts'
import { transaction, type Database } from './database.ts'
import type { RequireAccount } from './auth.ts'

const LIVE = ''
const quota = 2 * 1024 * MIB
const maxFile = 64 * MIB
const expiry = () => Date.now() + 24 * HOUR

type Asset = { path: string; bytes: number; mime: string; digest: string }

export const getBatch = (db: Database, user: string, batch: string) => {
  const row = db
    .prepare('SELECT history_version FROM batches WHERE user_id=? AND id=? AND expires>?')
    .get(user, batch, Date.now())
  if (!row) {
    throw missing()
  }
  return Number(row.history_version)
}

export const registerAssets = (
  app: FastifyInstance,
  db: Database,
  directory: string,
  account: RequireAccount
) => {
  const root = join(directory, 'attachments')
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const clean = () => {
    const now = Date.now()
    const expired = transaction(db, () => {
      db.prepare('DELETE FROM batches WHERE expires <= ?').run(now)
      db.prepare('DELETE FROM logins WHERE expires <= ?').run(now)
      db.prepare('DELETE FROM invitations WHERE expires <= ?').run(now)
      db.prepare('DELETE FROM auth_limits WHERE expires <= ?').run(now)
      return db
        .prepare(`
        DELETE FROM assets
        WHERE (scope <> '' AND NOT EXISTS (
          SELECT 1 FROM batches b WHERE b.user_id = assets.user_id AND b.id = assets.scope
        )) OR (scope = '' AND expires <= ? AND NOT EXISTS (
          SELECT 1 FROM session_assets r WHERE r.user_id = assets.user_id AND r.asset_id = assets.id
        )) RETURNING path
      `)
        .all(now)
    })
    for (const { path } of expired) {
      void rm(join(root, String(path)), { force: true }).catch(() =>
        app.log.warn('Attachment cleanup deferred')
      )
    }
  }
  const known = new Set(
    db
      .prepare('SELECT path FROM assets')
      .all()
      .map((row) => row.path)
  )
  for (const name of readdirSync(root)) {
    if (/^[a-f0-9-]{36}(?:\.part)?$/.test(name) && !known.has(name)) {
      rmSync(join(root, name), { force: true })
    }
  }
  clean()
  const timer = setInterval(clean, HOUR).unref()
  app.addHook('onClose', () => {
    clearInterval(timer)
  })

  const findAsset = db.prepare(
    'SELECT path, bytes, mime, digest FROM assets WHERE user_id=? AND scope=? AND id=?'
  )
  app.put<{ Params: { id: string }; Querystring: { batch?: string } }>(
    '/api/assets/:id',
    async (request, reply) => {
      const user = account(request, reply).id
      const id = identifier(request.params.id)
      const scope = request.query.batch === undefined ? LIVE : identifier(request.query.batch)
      if (scope) {
        getBatch(db, user, scope)
      }
      const body = request.body as Readable | undefined
      if (typeof body?.pipe !== 'function') {
        throw invalid('Expected binary file')
      }
      if (Number(request.headers['content-length']) > maxFile) {
        throw new HttpError(413, 'file_size', 'Attachment is too large')
      }
      const header = request.headers['x-mio-file-type']
      const mime =
        typeof header === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(header) && header.length <= 127
          ? header
          : ''
      const file = randomUUID()
      const partial = join(root, `${file}.part`)
      const hash = createHash('sha256')
      let bytes = 0
      let keep = false
      try {
        await pipeline(
          body,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length
              if (bytes > maxFile) {
                callback(new HttpError(413, 'file_size', 'Attachment is too large'))
                return
              }
              hash.update(chunk)
              callback(null, chunk)
            },
          }),
          createWriteStream(partial, { flags: 'wx', mode: 0o600 })
        )
        const descriptor = await open(partial, 'r+')
        try {
          await descriptor.sync()
        } finally {
          await descriptor.close()
        }
        await rename(partial, join(root, file))
        const digest = hash.digest('hex')
        account(request, reply)
        keep = transaction(db, () => {
          if (scope) {
            getBatch(db, user, scope)
          }
          const previous = findAsset.get(user, scope, id) as Asset | undefined
          if (previous) {
            if (previous.digest !== digest) {
              throw conflict()
            }
            db.prepare('UPDATE assets SET expires=? WHERE user_id=? AND scope=? AND id=?').run(
              expiry(),
              user,
              scope,
              id
            )
            return false
          }
          const total = Number(
            db
              .prepare(`
          SELECT COALESCE(SUM(bytes), 0) AS total FROM assets WHERE user_id = ? AND scope = ?
        `)
              .get(user, scope)?.total
          )
          if (total + bytes > quota) {
            throw new HttpError(413, 'storage_quota', 'Attachment storage quota reached')
          }
          db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            user,
            scope,
            id,
            file,
            bytes,
            mime,
            digest,
            expiry()
          )
          return true
        })
        return reply.code(204).send()
      } finally {
        if (!keep) {
          await Promise.all([rm(partial, { force: true }), rm(join(root, file), { force: true })])
        }
      }
    }
  )

  app.get<{ Params: { id: string } }>('/api/assets/:id', (request, reply) => {
    const user = account(request, reply).id
    const id = identifier(request.params.id)
    const asset = findAsset.get(user, LIVE, id) as Asset | undefined
    const referenced = db
      .prepare('SELECT 1 FROM session_assets WHERE user_id=? AND asset_id=? LIMIT 1')
      .get(user, id)
    if (!asset || !referenced) {
      throw missing()
    }
    return reply
      .type('application/octet-stream')
      .header('content-length', asset.bytes)
      .header('x-mio-file-type', asset.mime || 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(join(root, asset.path)))
  })
  return clean
}
