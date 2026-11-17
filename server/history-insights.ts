import type { FastifyInstance } from 'fastify'
import type { Message, Session, SessionSearchResult } from '../src/services/chat/types.js'
import { addUsage, emptyUsage, readTokenUsage } from '../src/services/chat/usage.ts'
import type { RequireAccount } from './auth.ts'
import { invalid } from './config.ts'
import type { Database } from './database.ts'

const texts = (message: Message) => {
  if (message.role === 'user') {
    return [message.content, ...message.files.map((file) => file.name)]
  }
  return message.blocks.flatMap((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return [block.text]
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return [block.thinking]
    }
    return []
  })
}

const excerpt = (text: string, match: RegExpExecArray) => {
  const start = Math.max(0, match.index - 40)
  const end = Math.min(text.length, match.index + match[0].length + 80)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

const searchSession = (session: Session, pattern: RegExp): SessionSearchResult | undefined => {
  const { id, title, createdAt, updatedAt, pinned } = session
  const summary = { id, title, createdAt, updatedAt, pinned: pinned === true }
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (message.role === 'assistant' && message.stopReason === 'refusal') {
      continue
    }
    for (const text of texts(message)) {
      const match = pattern.exec(text)
      if (match) {
        return { session: summary, messageId: message.id, snippet: excerpt(text, match) }
      }
    }
  }
  return pattern.test(title) ? { session: summary } : undefined
}

export const registerHistoryInsights = (
  app: FastifyInstance,
  db: Database,
  account: RequireAccount
) => {
  const rows = db.prepare(
    'SELECT body FROM sessions WHERE user_id=? AND body IS NOT NULL ORDER BY updated DESC, id'
  )
  const sessions = function* (user: string) {
    for (const row of rows.iterate(user)) {
      yield JSON.parse(String(row.body)) as Session
    }
  }
  app.get<{ Querystring: { q?: string } }>('/api/history/search', (request, reply) => {
    const user = account(request, reply).id
    const query = request.query.q
    if (typeof query !== 'string' || query.length > 200) {
      throw invalid('Invalid search query')
    }
    const results: SessionSearchResult[] = []
    if (!query.trim()) {
      return { results, more: false }
    }
    const pattern = new RegExp(RegExp.escape(query.trim()), 'iu')
    for (const session of sessions(user)) {
      const result = searchSession(session, pattern)
      if (result) {
        if (results.length === 40) {
          return { results, more: true }
        }
        results.push(result)
      }
    }
    return { results, more: false }
  })

  app.get('/api/history/usage', (request, reply) => {
    const user = account(request, reply).id
    let usage = emptyUsage()
    let replies = 0
    for (const session of sessions(user)) {
      for (const message of session.messages) {
        const recorded = message.role === 'assistant' ? readTokenUsage(message.usage) : undefined
        if (recorded) {
          usage = addUsage(usage, recorded)
          replies += 1
        }
      }
    }
    return { usage, replies }
  })
}
