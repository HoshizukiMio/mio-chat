import { checkResponse, jsonRequest, MioError, mioFetch } from '../account.js'
import { createId } from '../../utils/id.js'
import type { Session, SessionSummary } from './types.js'

export type StoredFile = { id: string; blob: Blob }
type Snapshot = { generation: number; sessions: (SessionSummary & { revision: number })[] }
type Mutation = { method: string; data: Record<string, unknown>; payload: Record<string, unknown> }

const createStorage = () => ({
  generation: 0,
  revisions: new Map<string, number>(),
  writes: new Map<string, Promise<unknown>>(),
  unconfirmed: new Map<string, Mutation>(),
  localFiles: new Map<string, Blob>(),
})
let storage = createStorage()
export const resetStorage = () => {
  storage = createStorage()
}

const json = async <T>(path: string, request?: RequestInit) =>
  (await (await checkResponse(await mioFetch(path, request))).json()) as T
const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`
const filePath = (id: string) => `/api/assets/${encodeURIComponent(id)}`
const batchPath = (batch: string) => `/api/history/batches/${encodeURIComponent(batch)}`

const adopt = (snapshot: Snapshot, state: typeof storage) => {
  state.generation = snapshot.generation
  state.revisions.clear()
  return snapshot.sessions.map(({ revision, ...summary }) => {
    state.revisions.set(summary.id, revision)
    return summary
  })
}
export const loadSessionSummaries = () => {
  const state = storage
  return json<Snapshot>('/api/sessions').then((snapshot) => adopt(snapshot, state))
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const state = storage
  await state.writes.get(id)?.catch(() => {})
  for (let attempt = 0; attempt < 2; attempt++) {
    if (state !== storage) {
      throw new DOMException('Signed out', 'AbortError')
    }
    const response = await mioFetch(sessionPath(id))
    if (response.status === 404) {
      return undefined
    }
    const { generation, revision, session } = (await (await checkResponse(response)).json()) as {
      generation: number
      revision: number
      session: Session
    }
    if (generation !== state.generation) {
      throw new MioError(409, 'conflict', 'History has changed')
    }
    if (revision >= (state.revisions.get(id) ?? 0)) {
      state.revisions.set(id, revision)
      return session
    }
  }
  throw new MioError(409, 'conflict', 'History has changed')
}

const upload = async ({ id, blob }: StoredFile, batch?: string) => {
  const query = batch ? `?batch=${encodeURIComponent(batch)}` : ''
  await checkResponse(
    await mioFetch(filePath(id) + query, {
      method: 'PUT',
      body: blob,
      headers: {
        'content-type': 'application/octet-stream',
        'x-mio-file-type': blob.type,
      },
    })
  )
}

const write = (
  id: string,
  method: string,
  data: Record<string, unknown>,
  files: StoredFile[] = []
) => {
  const state = storage
  const generation = state.generation
  for (const { id: fileId, blob } of files) {
    state.localFiles.set(fileId, blob)
  }
  const current = state.writes.get(id)
  const task = (current ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const ensureCurrent = () => {
        if (state !== storage) {
          throw new DOMException('Signed out', 'AbortError')
        }
        if (generation !== state.generation) {
          throw new MioError(409, 'conflict', 'History has changed')
        }
      }
      const commit = async (mutation: Mutation) => {
        ensureCurrent()
        state.unconfirmed.set(id, mutation)
        try {
          const { revision } = await json<{ revision: number }>(
            sessionPath(id),
            jsonRequest(mutation.method, mutation.data)
          )
          state.revisions.set(id, revision)
          state.unconfirmed.delete(id)
        } catch (error) {
          if (error instanceof MioError && error.status < 500) {
            state.unconfirmed.delete(id)
          }
          throw error
        }
      }
      ensureCurrent()
      const previous = state.unconfirmed.get(id)
      if (previous) {
        await commit(previous)
        if (
          previous.method === method &&
          JSON.stringify(previous.payload) === JSON.stringify(data)
        ) {
          for (const { id: fileId } of files) {
            state.localFiles.delete(fileId)
          }
          return
        }
      }
      for (const file of files) {
        ensureCurrent()
        await upload(file)
      }
      const mutation = createId()
      await commit({
        method,
        payload: data,
        data: { ...data, generation, mutation, revision: state.revisions.get(id) ?? null },
      })
      for (const { id: fileId } of files) {
        state.localFiles.delete(fileId)
      }
    })
    .finally(() => {
      if (state.writes.get(id) === task) {
        state.writes.delete(id)
      }
    })
  state.writes.set(id, task)
  return task
}

export const hasPendingWrite = (id: string) => storage.writes.has(id)
export const waitForWrites = () => Promise.allSettled(storage.writes.values())
export const discardLocalFiles = (files: StoredFile[] = []) => {
  for (const { id } of files) {
    storage.localFiles.delete(id)
  }
}
export const saveSession = (session: Session, files?: StoredFile[]) =>
  write(session.id, 'PUT', { session }, files)
export const renameSession = (id: string, title: string) => write(id, 'PATCH', { title })
export const deleteSession = (id: string) => write(id, 'DELETE', {})

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const local = storage.localFiles.get(id)
  if (local) {
    return local
  }
  const response = await mioFetch(filePath(id))
  if (response.status === 404) {
    return undefined
  }
  const data = await (await checkResponse(response)).blob()
  return data.slice(0, data.size, response.headers.get('x-mio-file-type') ?? data.type)
}

export const beginReplacement = async () => {
  const state = storage
  const { id } = await json<{ id: string }>('/api/history/batches', { method: 'POST' })
  const path = batchPath(id)
  const ensureCurrent = () => {
    if (state !== storage) {
      throw new DOMException('Signed out', 'AbortError')
    }
  }
  return {
    async addStagingSession(session: Session) {
      ensureCurrent()
      await checkResponse(
        await mioFetch(
          `${path}/sessions/${encodeURIComponent(session.id)}`,
          jsonRequest('PUT', session)
        )
      )
    },
    async saveStagingFiles(files: StoredFile[]) {
      for (const file of files) {
        ensureCurrent()
        await upload(file, id)
      }
    },
    async commit() {
      ensureCurrent()
      const snapshot = await json<Snapshot>(`${path}/commit`, { method: 'POST' })
      state.unconfirmed.clear()
      state.localFiles.clear()
      return adopt(snapshot, state)
    },
    async cancel() {
      ensureCurrent()
      await checkResponse(await mioFetch(path, { method: 'DELETE' }))
    },
  }
}

export type HistoryStaging = Awaited<ReturnType<typeof beginReplacement>>
export const isConflict = (error: unknown) => error instanceof MioError && error.status === 409
export const reportStorageError = (action: string) => (error: unknown) => {
  if (!(error instanceof DOMException && error.name === 'AbortError')) {
    // eslint-disable-next-line no-console
    console.error(`[storage] ${action} failed`, error)
  }
}
