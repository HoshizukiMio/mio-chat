import { readConfig } from './config.ts'
import { issueInvitation } from './auth.ts'
import { openDatabase } from './database.ts'

const hours = Number(process.argv[2] ?? 168)
if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
  throw new Error('Invitation lifetime must be 1–720 hours')
}
const db = openDatabase(readConfig().directory)
try {
  process.stdout.write(`${issueInvitation(db, hours)}\n`)
} finally {
  db.close()
}
