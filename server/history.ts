import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Session } from '../src/services/chat/types.js'
import type { RequireAccount } from './auth.ts'
import { HOUR, MIB, conflict, identifier, invalid, missing, object } from './config.ts'
import { transaction, type Database } from './database.ts'
import { getBatch } from './assets.ts'
import { registerHistoryInsights } from './history-insights.ts'

const maxSessionSize = 32 * MIB
const timestamp = (input: unknown): input is number => Number.isSafeInteger(input)
const readSession = (input: unknown, id: string): Session => {
  const body = object(input)
  if (
    body.id !== id ||
    typeof body.title !== 'string' ||
    !timestamp(body.createdAt) ||
    !timestamp(body.updatedAt) ||
    ('pinned' in body && typeof body.pinned !== 'boolean') ||
    !Array.isArray(body.messages)
  ) {
    throw invalid('Invalid session')
  }
  const ids = new Set<string>()
  for (const entry of body.messages) {
    const message = object(entry)
    const messageId = identifier(message.id)
    if (ids.has(messageId) || !timestamp(message.createdAt)) {
      throw invalid('Invalid message')
    }
    ids.add(messageId)
    if (
      message.role === 'user' &&
      typeof message.content === 'string' &&
      Array.isArray(message.files)
    ) {
      for (const data of message.files) {
        const file = object(data)
        identifier(file.id)
        if (
          typeof file.name !== 'string' ||
          typeof file.isImage !== 'boolean' ||
          typeof file.mimeType !== 'string' ||
          !timestamp(file.size) ||
          file.size < 0 ||
          (file.serverId !== null && typeof file.serverId !== 'string')
        ) {
          throw invalid('Invalid attachment')
        }
      }
    } else if (
      message.role !== 'assistant' ||
      !Array.isArray(message.blocks) ||
      !['done', 'error', 'stopped', 'streaming', 'pending'].includes(String(message.status))
    ) {
      throw invalid('Invalid message')
    } else {
      for (const block of message.blocks) {
        if (typeof object(block).type !== 'string') {
          throw invalid('Invalid reply block')
        }
      }
    }
  }
  return body as Session
}

type Revision = { revision: number; mutation: string | null; body: string | null }
type Params = { id: string }
type StageParams = { batch: string; id: string }

export const registerHistory = (
  app: FastifyInstance,
  db: Database,
  account: RequireAccount,
  clean: () => void
) => {
  registerHistoryInsights(app, db, account)
  const profile = db.prepare('SELECT generation, history_version FROM users WHERE id=?')
  const current = db.prepare(
    'SELECT revision, mutation, body FROM sessions WHERE user_id=? AND id=?'
  )
  const list = db.prepare(`
    SELECT id,title,created AS createdAt,updated AS updatedAt,revision,
      COALESCE(json_extract(body, '$.pinned'), 0) AS pinned
    FROM sessions WHERE user_id=? AND body IS NOT NULL ORDER BY updated DESC, id
  `)
  const bump = db.prepare('UPDATE users SET history_version=history_version+1 WHERE id=?')
  const put = db.prepare(`
    INSERT INTO sessions (user_id,id,revision,mutation,body,title,created,updated) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (user_id,id) DO UPDATE SET
      revision=excluded.revision, mutation=excluded.mutation, body=excluded.body, title=excluded.title,
      created=excluded.created, updated=excluded.updated
  `)
  const references = db.prepare(
    'SELECT asset_id FROM session_assets WHERE user_id=? AND session_id=?'
  )
  const removeLinks = db.prepare('DELETE FROM session_assets WHERE user_id=? AND session_id=?')
  const link = db.prepare('INSERT OR IGNORE INTO session_assets VALUES (?,?,?)')
  const expireOrphan = db.prepare(`
    UPDATE assets SET expires=0 WHERE user_id=? AND id=? AND scope='' AND NOT EXISTS (
      SELECT 1 FROM session_assets r WHERE r.user_id=assets.user_id AND r.asset_id=assets.id
    )
  `)
  const store = (user: string, session: Session, revision: number, mutation: string | null) => {
    put.run(
      user,
      session.id,
      revision,
      mutation,
      JSON.stringify(session),
      session.title,
      session.createdAt,
      session.updatedAt
    )
    const previous = references.all(user, session.id)
    removeLinks.run(user, session.id)
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          link.run(user, session.id, file.id)
        }
      }
    }
    for (const { asset_id } of previous) {
      expireOrphan.run(user, String(asset_id))
    }
  }
  const snapshot = (user: string) => ({
    generation: Number(profile.get(user)?.generation),
    sessions: list.all(user).map(({ pinned, ...row }) => ({ ...row, pinned: pinned === 1 })),
  })
  const writeSession = (
    user: string,
    id: string,
    data: Record<string, unknown>,
    apply: (old: Revision | undefined, revision: number, mutation: string) => void
  ) =>
    transaction(db, () => {
      if (profile.get(user)?.generation !== data.generation) {
        throw conflict()
      }
      const old = current.get(user, id) as Revision | undefined
      const mutation = identifier(data.mutation)
      if (old?.mutation === mutation) {
        return { revision: old.revision }
      }
      if ((old?.revision ?? null) !== data.revision || old?.body === null) {
        throw conflict()
      }
      const revision = (old?.revision ?? 0) + 1
      apply(old, revision, mutation)
      bump.run(user)
      return { revision }
    })

  app.get('/api/sessions', (request, reply) => snapshot(account(request, reply).id))
  app.get<{ Params: Params }>('/api/sessions/:id', (request, reply) => {
    const user = account(request, reply).id
    const row = current.get(user, identifier(request.params.id)) as Revision | undefined
    if (!row?.body) {
      throw missing()
    }
    return {
      generation: Number(profile.get(user)?.generation),
      revision: row.revision,
      session: JSON.parse(row.body) as Session,
    }
  })
  app.put<{ Params: Params }>(
    '/api/sessions/:id',
    { bodyLimit: maxSessionSize },
    (request, reply) => {
      const user = account(request, reply).id
      const id = identifier(request.params.id)
      const body = object(request.body)
      const session = readSession(body.session, id)
      return writeSession(user, id, body, (_old, revision, mutation) =>
        store(user, session, revision, mutation)
      )
    }
  )
  app.patch<{ Params: Params }>('/api/sessions/:id', (request, reply) => {
    const user = account(request, reply).id
    const id = identifier(request.params.id)
    const body = object(request.body)
    const title = body.title
    const pinned = body.pinned
    if (
      (title === undefined && pinned === undefined) ||
      (title !== undefined && typeof title !== 'string') ||
      (pinned !== undefined && typeof pinned !== 'boolean')
    ) {
      throw invalid('Invalid session metadata')
    }
    return writeSession(user, id, body, (old, revision, mutation) => {
      if (!old?.body) {
        throw missing()
      }
      const session = JSON.parse(old.body) as Session
      session.title = title ?? session.title
      if (pinned !== undefined) {
        session.pinned = pinned
      }
      put.run(
        user,
        id,
        revision,
        mutation,
        JSON.stringify(session),
        session.title,
        session.createdAt,
        session.updatedAt
      )
    })
  })
  app.delete<{ Params: Params }>('/api/sessions/:id', (request, reply) => {
    const user = account(request, reply).id
    const id = identifier(request.params.id)
    const data = writeSession(user, id, object(request.body), (_old, revision, mutation) => {
      const previous = references.all(user, id)
      removeLinks.run(user, id)
      put.run(user, id, revision, mutation, null, null, null, null)
      for (const { asset_id } of previous) {
        expireOrphan.run(user, String(asset_id))
      }
    })
    clean()
    return data
  })
  app.post('/api/history/batches', (request, reply) => {
    const user = account(request, reply).id
    const id = randomUUID()
    const count = Number(
      db
        .prepare('SELECT COUNT(*) AS count FROM batches WHERE user_id=? AND expires>?')
        .get(user, Date.now())?.count
    )
    if (count >= 3) {
      throw conflict()
    }
    db.prepare('INSERT INTO batches VALUES (?,?,?,?)').run(
      user,
      id,
      Number(profile.get(user)?.history_version),
      Date.now() + HOUR
    )
    return { id }
  })
  app.put<{ Params: StageParams }>(
    '/api/history/batches/:batch/sessions/:id',
    { bodyLimit: maxSessionSize },
    (request, reply) => {
      const user = account(request, reply).id
      const batch = identifier(request.params.batch)
      const id = identifier(request.params.id)
      getBatch(db, user, batch)
      const session = readSession(request.body, id)
      db.prepare(`
      INSERT INTO staged_sessions VALUES (?,?,?,?) ON CONFLICT (user_id,batch,id) DO UPDATE SET body=excluded.body
    `).run(user, batch, id, JSON.stringify(session))
      return reply.code(204).send()
    }
  )
  app.delete<{ Params: { batch: string } }>('/api/history/batches/:batch', (request, reply) => {
    const user = account(request, reply).id
    db.prepare('DELETE FROM batches WHERE user_id=? AND id=?').run(
      user,
      identifier(request.params.batch)
    )
    clean()
    return reply.code(204).send()
  })
  app.post<{ Params: { batch: string } }>(
    '/api/history/batches/:batch/commit',
    (request, reply) => {
      const user = account(request, reply).id
      const batch = identifier(request.params.batch)
      const snapshotAfter = transaction(db, () => {
        if (getBatch(db, user, batch) !== profile.get(user)?.history_version) {
          throw conflict()
        }
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user)
        // Move the old assets out of the live namespace. Cleanup unlinks them after commit.
        db.prepare("UPDATE assets SET scope=? WHERE user_id=? AND scope=''").run(
          `purge-${batch}`,
          user
        )
        db.prepare("UPDATE assets SET scope='' WHERE user_id=? AND scope=?").run(user, batch)
        const mime = db.prepare("SELECT mime FROM assets WHERE user_id=? AND scope='' AND id=?")
        const rows = db
          .prepare('SELECT body FROM staged_sessions WHERE user_id=? AND batch=?')
          .iterate(user, batch)
        for (const row of rows) {
          const session = JSON.parse(String(row.body)) as Session
          for (const message of session.messages) {
            if (message.role === 'user') {
              for (const file of message.files) {
                file.mimeType = String(mime.get(user, file.id)?.mime ?? '')
                file.serverId = null
              }
            }
          }
          store(user, session, 1, null)
        }
        db.prepare('DELETE FROM batches WHERE user_id=? AND id=?').run(user, batch)
        db.prepare(
          'UPDATE users SET generation=generation+1, history_version=history_version+1 WHERE id=?'
        ).run(user)
        return snapshot(user)
      })
      clean()
      return snapshotAfter
    }
  )
}
