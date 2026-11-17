import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const openDatabase = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'mio-chat.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      api_key TEXT, key_version INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, history_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS logins (
      token TEXT PRIMARY KEY, context TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_limits (scope TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, revision INTEGER NOT NULL,
      mutation TEXT, body TEXT, title TEXT, created INTEGER, updated INTEGER,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(user_id, updated DESC) WHERE body IS NOT NULL;
    CREATE TABLE IF NOT EXISTS batches (
      user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, history_version INTEGER NOT NULL,
      expires INTEGER NOT NULL, PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS staged_sessions (
      user_id TEXT NOT NULL, batch TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (user_id, batch, id),
      FOREIGN KEY (user_id, batch) REFERENCES batches(user_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS assets (
      user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, mime TEXT NOT NULL, digest TEXT NOT NULL,
      expires INTEGER NOT NULL, PRIMARY KEY (user_id, scope, id)
    );
    CREATE TABLE IF NOT EXISTS session_assets (
      user_id TEXT NOT NULL, session_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY (user_id, session_id, asset_id),
      FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_asset_owner ON session_assets(user_id, asset_id);
    CREATE TABLE IF NOT EXISTS provider_files (
      user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, key_version INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `)
  return db
}

export type Database = ReturnType<typeof openDatabase>

export const transaction = <T>(db: Database, operation: () => T) => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
