import { neon } from '@neondatabase/serverless';

let client;
let schemaPromise;

function getClient() {
  if (!process.env.DATABASE_URL) throw new Error('未配置 DATABASE_URL');
  return client ??= neon(process.env.DATABASE_URL);
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getClient();
      await sql`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        photo_revision INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        first_meeting_date TEXT,
        person_one_name TEXT NOT NULL DEFAULT '',
        person_two_name TEXT NOT NULL DEFAULT '',
        phone_number TEXT
      )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique
        ON users(phone_number) WHERE phone_number IS NOT NULL AND phone_number <> ''`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`;
      await sql`CREATE TABLE IF NOT EXISTS photos (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        thumbnail TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        blob_url TEXT NOT NULL,
        size BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS photo_uploads (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        photo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        thumbnail TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, photo_id)
      )`;
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

function withPlaceholders(statement) {
  let index = 0;
  return statement.replace(/\?/g, () => `$${++index}`);
}

export async function query(statement, parameters = []) {
  await ensureSchema();
  return getClient().query(withPlaceholders(statement), parameters);
}

export async function get(statement, parameters = []) {
  return (await query(statement, parameters))[0] ?? null;
}

export async function all(statement, parameters = []) {
  return query(statement, parameters);
}

export async function run(statement, parameters = []) {
  await ensureSchema();
  const result = await getClient().query(withPlaceholders(statement), parameters, { fullResults: true });
  return { changes: result.rowCount };
}
