import type { MessageUsage } from '../api/types.js'

const tokenFields = [
  'input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
] as const

export type TokenUsage = Pick<MessageUsage, (typeof tokenFields)[number]>
export type AccountUsage = { usage: TokenUsage; replies: number }

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
})

export const readTokenUsage = (value: unknown): TokenUsage | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const usage = emptyUsage()
  for (const key of tokenFields) {
    const count = record[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return undefined
    }
    usage[key] = count
  }
  return usage
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
})

export const inputTokens = (usage: TokenUsage) =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
export const totalTokens = (usage: TokenUsage) => inputTokens(usage) + usage.output_tokens
