import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createApp } from './app.ts'
import { issueInvitation } from './auth.ts'
import { openDatabase } from './database.ts'
import { readConfig } from './config.ts'

const password = 'integration-pass-123'
type TestApp = Awaited<ReturnType<typeof createApp>>
type Login = { cookie: string; 'x-mio-session': string }
const headers = { 'x-mio-request': '1' }

const fixture = async (t: TestContext, mode = 'open', fetchUpstream?: typeof fetch) => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-chat-'))
  const config = readConfig({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://mio.example',
    MIO_DATA_DIR: directory,
    MIO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    REGISTRATION_MODE: mode,
  })
  const first = await createApp(config, fetchUpstream, false)
  const apps = new Set([first])
  t.after(async () => {
    await Promise.all([...apps].map((app) => app.close()))
    rmSync(directory, { force: true, recursive: true })
  })
  const restart = async (registration = config.registration) => {
    const previous = [...apps].at(-1)
    if (previous) {
      await previous.close()
      apps.delete(previous)
    }
    const app = await createApp({ ...config, registration }, fetchUpstream, false)
    apps.add(app)
    return app
  }
  return { app: first, directory, restart }
}

const register = (app: TestApp, username: string, invitation?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { username, password, invitation },
  })
const login = (app: TestApp, username: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username, password } })
const access = (result: Awaited<ReturnType<typeof register>>): Login => {
  assert.ok(result.statusCode === 200 || result.statusCode === 201, result.body)
  assert.match(String(result.headers['set-cookie']), /HttpOnly/)
  assert.match(String(result.headers['set-cookie']), /Secure/)
  return {
    cookie: String(result.headers['set-cookie']).split(';')[0],
    'x-mio-session': result.json().user.context,
  }
}

test('registration modes, atomic invitations, cookie session and rate limits', async (t) => {
  const { app, directory, restart } = await fixture(t, 'invite')
  const db = openDatabase(directory)
  const invite = issueInvitation(db)
  const unused = issueInvitation(db)
  db.close()
  assert.equal((await register(app, 'alice')).statusCode, 403)
  const attempts = await Promise.all([register(app, 'alice', invite), register(app, 'bob', invite)])
  const [success] = attempts.filter((result) => result.statusCode === 201)
  assert.deepEqual(attempts.map((result) => result.statusCode).sort(), [201, 403])
  const alice = success.json().user.username as string
  assert.equal((await register(app, alice, unused)).statusCode, 409)
  const second = access(await register(app, 'charlie', unused))
  assert.equal((await app.inject({ url: '/api/sessions', headers: second })).statusCode, 200)

  const closed = await restart('closed')
  assert.deepEqual((await closed.inject('/api/auth/session')).json(), {
    mode: 'closed',
    user: null,
  })
  assert.equal((await register(closed, 'newuser')).statusCode, 403)
  const signedIn = access(await login(closed, alice))
  assert.equal(
    (
      await closed.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...signedIn, ...headers },
      })
    ).statusCode,
    204
  )
  assert.equal((await closed.inject({ url: '/api/sessions', headers: signedIn })).statusCode, 401)
  const open = await restart('open')
  assert.equal((await register(open, 'newuser')).statusCode, 201)
  assert.equal(
    (
      await open.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...headers, origin: 'https://elsewhere.example' },
        payload: { username: 'newuser', password },
      })
    ).statusCode,
    403
  )
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await open.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'unknown', password },
    })
    assert.equal(response.statusCode, 401)
  }
  assert.equal((await login(open, 'unknown')).statusCode, 429)
})

const session = (id: string, file: string) => ({
  id,
  title: 'first draft',
  createdAt: 100,
  updatedAt: 200,
  messages: [
    {
      id: 'message',
      role: 'user',
      createdAt: 100,
      content: 'hello',
      files: [
        {
          id: file,
          serverId: null,
          name: 'original.png',
          size: 3,
          isImage: true,
          mimeType: 'image/png',
        },
      ],
    },
  ],
})

test('account isolation, attachment persistence, mutation replay and atomic history replacement', async (t) => {
  const { app, restart } = await fixture(t)
  const first = access(await register(app, 'alice'))
  const second = access(await login(app, 'alice'))
  const other = access(await register(app, 'bob'))
  const api = (
    instance: TestApp,
    who: Login,
    url: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET',
    payload?: object | Buffer
  ) =>
    instance.inject({
      method,
      url,
      payload,
      headers: {
        ...headers,
        ...who,
        ...(Buffer.isBuffer(payload)
          ? { 'content-type': 'application/octet-stream', 'x-mio-file-type': 'image/png' }
          : {}),
      },
    })
  assert.equal(
    (await api(app, { ...first, cookie: other.cookie }, '/api/sessions')).statusCode,
    401
  )
  assert.equal(
    (await api(app, first, '/api/assets/original', 'PUT', Buffer.from('abc'))).statusCode,
    204
  )
  assert.equal((await api(app, first, '/api/assets/original')).statusCode, 404)
  const original = session('same-id', 'original')
  const save = { session: original, generation: 0, revision: null, mutation: 'create' }
  assert.deepEqual((await api(app, first, '/api/sessions/same-id', 'PUT', save)).json(), {
    revision: 1,
  })
  assert.deepEqual((await api(app, first, '/api/sessions/same-id', 'PUT', save)).json(), {
    revision: 1,
  })
  assert.equal(
    (await api(app, second, '/api/sessions/same-id')).json().session.title,
    original.title
  )
  assert.equal((await api(app, other, '/api/sessions/same-id')).statusCode, 404)
  assert.equal((await api(app, other, '/api/assets/original')).statusCode, 404)
  assert.equal(
    (await api(app, other, '/api/assets/original', 'PUT', Buffer.from('xyz'))).statusCode,
    204
  )
  assert.equal((await api(app, other, '/api/sessions/same-id', 'PUT', save)).statusCode, 200)
  assert.equal((await api(app, other, '/api/assets/original')).body, 'xyz')

  const editing = (await api(app, first, '/api/history/batches', 'POST')).json().id
  const update = {
    ...save,
    revision: 1,
    mutation: 'update',
    session: { ...original, title: 'updated' },
  }
  assert.equal((await api(app, first, '/api/sessions/same-id', 'PUT', update)).statusCode, 200)
  assert.equal(
    (await api(app, second, '/api/sessions/same-id', 'PUT', { ...update, mutation: 'stale' }))
      .statusCode,
    409
  )
  assert.equal(
    (await api(app, first, `/api/history/batches/${editing}/commit`, 'POST')).statusCode,
    409
  )
  assert.equal((await api(app, first, `/api/history/batches/${editing}`, 'DELETE')).statusCode, 204)
  const afterRestart = await restart()
  assert.equal((await api(afterRestart, first, '/api/assets/original')).body, 'abc')
  assert.equal(
    (await api(afterRestart, first, '/api/sessions/same-id')).json().session.title,
    'updated'
  )

  const { id } = (await api(afterRestart, first, '/api/history/batches', 'POST')).json()
  const imported = session('imported', 'original')
  assert.equal(
    (
      await api(
        afterRestart,
        other,
        `/api/history/batches/${id}/sessions/imported`,
        'PUT',
        imported
      )
    ).statusCode,
    404
  )
  assert.equal(
    (
      await api(
        afterRestart,
        first,
        `/api/history/batches/${id}/sessions/imported`,
        'PUT',
        imported
      )
    ).statusCode,
    204
  )
  assert.equal(
    (await api(afterRestart, first, `/api/assets/original?batch=${id}`, 'PUT', Buffer.from('new')))
      .statusCode,
    204
  )
  assert.equal((await api(afterRestart, first, '/api/assets/original')).body, 'abc')
  const committed = await api(afterRestart, first, `/api/history/batches/${id}/commit`, 'POST')
  assert.equal(committed.json().generation, 1)
  assert.deepEqual(
    committed.json().sessions.map((item: { id: string }) => item.id),
    ['imported']
  )
  assert.equal((await api(afterRestart, first, '/api/assets/original')).body, 'new')
  assert.equal(
    (await api(afterRestart, first, '/api/sessions/same-id', 'PUT', update)).statusCode,
    409
  )
  assert.equal((await api(afterRestart, other, '/api/assets/original')).body, 'xyz')
  assert.equal(
    (
      await api(afterRestart, first, '/api/sessions/imported', 'DELETE', {
        revision: 1,
        generation: 1,
        mutation: 'remove',
      })
    ).statusCode,
    200
  )
  assert.equal((await api(afterRestart, first, '/api/assets/original')).statusCode, 404)
})

test('DeepSeek keys stay encrypted at rest and drive stream, attachment and speech proxying', async (t) => {
  const upstream: typeof fetch = async (input, options) => {
    const path = new URL(String(input)).pathname
    const headers = new Headers(options?.headers)
    assert.equal(new URL(String(input)).origin, 'https://api.deepseek.com')
    const key = headers.get('x-api-key') ?? headers.get('authorization')?.replace('Bearer ', '')
    assert.ok(key === 'test-key-1' || key === 'test-key-2' || key === 'invalid-key')
    if (path === '/models') {
      return new Response(null, { status: key === 'invalid-key' ? 401 : 200 })
    }
    if (path.endsWith('/files') || path.endsWith('/asr')) {
      assert.match(headers.get('content-type') ?? '', /^multipart\/form-data;/)
      const chunks: Buffer[] = []
      const source = options?.body
      assert.ok(source)
      for await (const chunk of source as unknown as AsyncIterable<Buffer>) {
        chunks.push(chunk)
      }
      assert.match(Buffer.concat(chunks).toString(), /example/)
      return Response.json(
        path.endsWith('/files') ? { id: 'file-api-example' } : { text: 'voice example' }
      )
    }
    if (path.endsWith('/tts')) {
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/pcm' } })
    }
    const body = JSON.parse(String(options?.body))
    assert.equal(body.stream, true)
    assert.equal(body.safety_check.level, 'high')
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const { app, directory } = await fixture(t, 'open', upstream)
  const signedIn = access(await register(app, 'alice'))
  const bob = access(await register(app, 'bob'))
  const call = (
    url: string,
    method: 'PUT' | 'POST' | 'DELETE',
    payload?: object | string,
    who = signedIn,
    contentType?: string
  ) =>
    app.inject({
      method,
      url,
      payload,
      headers: { ...headers, ...who, ...(contentType ? { 'content-type': contentType } : {}) },
    })
  assert.equal(
    (await call('/api/account/api-key', 'PUT', { apiKey: 'invalid-key' })).statusCode,
    401
  )
  assert.deepEqual((await call('/api/account/api-key', 'PUT', { apiKey: 'test-key-1' })).json(), {
    hasApiKey: true,
  })
  const db = openDatabase(directory)
  const stored = db.prepare('SELECT api_key FROM users WHERE username=?').get('alice')?.api_key
  db.close()
  assert.ok(typeof stored === 'string' && !stored.includes('test-key-1'))
  const profile = await app.inject({ url: '/api/auth/session', headers: signedIn })
  assert.equal(profile.json().user.hasApiKey, true)
  assert.doesNotMatch(profile.body, /test-key-1/)

  const multipart = 'multipart/form-data; boundary=mio'
  const body =
    '--mio\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n\r\nexample\r\n--mio--\r\n'
  assert.equal(
    (await call('/api/deepseek/anthropic/v1/files', 'POST', body, signedIn, multipart)).json().id,
    'file-api-example'
  )
  const request = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'document', source: { type: 'file', file_id: 'file-api-example' } }],
      },
    ],
  }
  const stream = await call('/api/deepseek/anthropic/v1/messages', 'POST', request)
  assert.match(String(stream.headers['content-type']), /^text\/event-stream/)
  assert.match(stream.body, /message_stop/)
  assert.equal(
    (await call('/api/deepseek/v1/tools/asr', 'POST', body, signedIn, multipart)).json().text,
    'voice example'
  )
  assert.deepEqual(
    (await call('/api/deepseek/v1/tools/tts', 'POST', { text: 'test' })).rawPayload,
    Buffer.from([1, 2])
  )
  await call('/api/account/api-key', 'PUT', { apiKey: 'test-key-2' }, bob)
  assert.equal(
    (await call('/api/deepseek/anthropic/v1/messages', 'POST', request, bob)).statusCode,
    400
  )
  await call('/api/account/api-key', 'PUT', { apiKey: 'test-key-2' })
  assert.equal((await call('/api/deepseek/anthropic/v1/messages', 'POST', request)).statusCode, 400)
  assert.deepEqual((await call('/api/account/api-key', 'DELETE')).json(), { hasApiKey: false })
})
