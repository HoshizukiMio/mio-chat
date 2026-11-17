import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import serveStatic from '@fastify/static'
import Fastify from 'fastify'
import { openDatabase } from './database.ts'
import { HttpError, type Config } from './config.ts'
import { registerAuth } from './auth.ts'
import { registerAssets } from './assets.ts'
import { registerHistory } from './history.ts'
import { registerDeepSeek } from './deepseek.ts'

export const createApp = async (config: Config, upstreamFetch = fetch, logger = true) => {
  const app = Fastify({
    logger,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy ?? false,
    requestTimeout: 15 * 60_000,
  })
  const db = openDatabase(config.directory)
  app.addHook('onClose', () => {
    db.close()
  })
  await app.register(cookie)
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload)
  )
  app.addContentTypeParser(/^multipart\/form-data\b/, (_request, payload, done) =>
    done(null, payload)
  )
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) {
      return
    }
    void reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
    const mutating = request.method !== 'GET' && request.method !== 'HEAD'
    if (
      mutating &&
      (request.headers['x-mio-request'] !== '1' ||
        (request.headers.origin && request.headers.origin !== config.origin))
    ) {
      throw new HttpError(403, 'origin', 'Request must originate from Mio Chat')
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } })
    }
    const status =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    if (status >= 500) {
      app.log.error({ name: error instanceof Error ? error.name : 'Unknown' }, 'Request failed')
    }
    return reply
      .code(status)
      .send({
        error: {
          code: 'request_failed',
          message:
            status >= 500 || !(error instanceof Error) ? 'Server request failed' : error.message,
        },
      })
  })
  app.get('/api/health', () => ({ ok: true }))
  const account = registerAuth(app, db, config)
  const clean = registerAssets(app, db, config.directory, account)
  registerHistory(app, db, account, clean)
  registerDeepSeek(app, db, config, account, upstreamFetch)
  const dist = resolve('dist')
  if (existsSync(dist)) {
    await app.register(serveStatic, { root: dist, cacheControl: false })
  }
  return app
}
