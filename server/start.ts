import { readConfig } from './config.ts'
import { createApp } from './app.ts'

const config = readConfig()
const app = await createApp(config)
await app.listen({ host: config.host, port: config.port })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close())
}
