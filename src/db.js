/**
 * Postgres data layer.
 *
 * Production (Vercel) talks to Neon over `pg`. With no POSTGRES_URL set we fall
 * back to PGlite — a real Postgres running in-process — so the app runs locally
 * with no database to install and no credentials to hold.
 *
 * Serverless calls this on every cold start, so schema creation and admin
 * seeding are guarded by a cached promise and are safe to run repeatedly.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Timestamps and COUNT(*) come back as int8, which pg stringifies by default.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

let clientPromise = null;

async function connect() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (url) {
    // One small pool per warm instance; serverless reuses it across invocations.
    const pool = new pg.Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 10_000,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    return { query: (text, params) => pool.query(text, params) };
  }

  // PGlite writes to disk, which serverless does not have. Fail with something
  // readable rather than an ENOENT from deep inside the driver.
  if (process.env.VERCEL) {
    const err = new Error(
      'No database configured. In Vercel: Storage → Create Database → Neon (Postgres), ' +
        'which sets POSTGRES_URL, then redeploy.'
    );
    err.code = 'CONFIG';
    throw err;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const dir = process.env.PGLITE_DIR || './data/pgdata';
  mkdirSync(dirname(dir), { recursive: true }); // PGlite won't create its parent
  const lite = await PGlite.create(dir);
  return {
    query: async (text, params) => {
      const result = await lite.query(text, params);
      // PGlite hands back bigint for int8; normalise it to plain numbers.
      return { rows: result.rows.map(normalizeRow) };
    },
  };
}

const normalizeRow = (row) => {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE,
    name         TEXT NOT NULL,
    password     TEXT,
    role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at   BIGINT NOT NULL,
    last_seen_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL DEFAULT 'Support request',
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    user_read_at    BIGINT NOT NULL DEFAULT 0,
    admin_read_at   BIGINT NOT NULL DEFAULT 0,
    user_typing_at  BIGINT NOT NULL DEFAULT 0,
    admin_typing_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role     TEXT NOT NULL CHECK (sender_role IN ('user','admin','system')),
    body            TEXT NOT NULL,
    created_at      BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
`;

/** Resolves to a ready client: connected, migrated, admin seeded. */
export function db() {
  clientPromise ??= (async () => {
    const client = await connect();
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await client.query(statement);
    }
    await seedAdmin(client);
    return client;
  })().catch((err) => {
    clientPromise = null; // never cache a failed connection — let the next request retry
    throw err;
  });
  return clientPromise;
}

const query = async (text, params) => (await db()).query(text, params);
const one = async (text, params) => (await query(text, params)).rows[0] ?? null;
const all = async (text, params) => (await query(text, params)).rows;

const now = () => Date.now();

/**
 * Creates the support account from the environment on first boot. Imported by
 * db() rather than exported, so it can never race with a request.
 */
async function seedAdmin(client) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await client.query('SELECT id FROM users WHERE email = $1', [
    String(email).toLowerCase(),
  ]);
  if (existing.rows.length > 0) return;

  const bcrypt = (await import('bcryptjs')).default;
  await client.query(
    `INSERT INTO users (id, email, name, password, role, created_at)
     VALUES ($1, $2, $3, $4, 'admin', $5)
     ON CONFLICT (email) DO NOTHING`,
    [
      randomUUID(),
      String(email).toLowerCase(),
      process.env.ADMIN_NAME || 'Support Team',
      await bcrypt.hash(password, 10),
      now(),
    ]
  );
  console.log(`[auth] Seeded admin account ${email}`);
}

/* ---------------------------------------------------------------- users -- */

export const users = {
  async create({ email = null, name, password = null, role = 'user' }) {
    const id = randomUUID();
    await query(
      `INSERT INTO users (id, email, name, password, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email ? String(email).toLowerCase() : null, name, password, role, now()]
    );
    return this.byId(id);
  },

  /** A visitor with no account: named for the agent's benefit, nothing more. */
  createGuest() {
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    return this.create({ name: `Guest ${tag}` });
  },

  rename(id, name) {
    return one('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name, id]);
  },

  byId(id) {
    return one('SELECT * FROM users WHERE id = $1', [id]);
  },

  byEmail(email) {
    return one('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  },

  touch(id) {
    return query('UPDATE users SET last_seen_at = $1 WHERE id = $2', [now(), id]);
  },
};

/* ------------------------------------------------------------- sessions -- */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const sessions = {
  async create(userId) {
    const token = randomUUID() + randomUUID().replaceAll('-', '');
    const ts = now();
    await query(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [token, userId, ts, ts + SESSION_TTL_MS]
    );
    return { token, expiresAt: ts + SESSION_TTL_MS };
  },

  userFor(token) {
    if (!token) return null;
    return one(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > $2`,
      [token, now()]
    );
  },

  destroy(token) {
    if (!token) return null;
    return query('DELETE FROM sessions WHERE token = $1', [token]);
  },
};

/* -------------------------------------------------------- conversations -- */

/** A side counts as present if it polled within this window. */
export const PRESENCE_WINDOW_MS = 20_000;
export const TYPING_WINDOW_MS = 4_000;

export const conversations = {
  /** Every customer gets exactly one private thread, created on demand. */
  async ensureFor(userId) {
    const existing = await one('SELECT * FROM conversations WHERE user_id = $1', [userId]);
    if (existing) return existing;
    const ts = now();
    return one(
      `INSERT INTO conversations (id, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [randomUUID(), userId, ts]
    );
  },

  byId(id) {
    return one('SELECT * FROM conversations WHERE id = $1', [id]);
  },

  setStatus(id, status) {
    return one(
      'UPDATE conversations SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [status, now(), id]
    );
  },

  setSubject(id, subject) {
    return one(
      'UPDATE conversations SET subject = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [subject, now(), id]
    );
  },

  markRead(id, role) {
    const column = role === 'admin' ? 'admin_read_at' : 'user_read_at';
    return query(`UPDATE conversations SET ${column} = $1 WHERE id = $2`, [now(), id]);
  },

  /** Polling replaces the typing socket event: stamp now, read it back later. */
  markTyping(id, role, isTyping) {
    const column = role === 'admin' ? 'admin_typing_at' : 'user_typing_at';
    return query(`UPDATE conversations SET ${column} = $1 WHERE id = $2`, [
      isTyping ? now() : 0,
      id,
    ]);
  },

  /** Inbox rows for the agent console, newest activity first. */
  list({ status = 'all', q = '', limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (status === 'open' || status === 'closed') {
      params.push(status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR c.subject ILIKE $${params.length})`
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);

    return all(
      `SELECT c.id, c.subject, c.status, c.updated_at, c.admin_read_at, c.user_typing_at,
              u.id AS user_id, u.name AS user_name, u.email AS user_email, u.last_seen_at,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT sender_role FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_role,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
                AND m.sender_role = 'user' AND m.created_at > c.admin_read_at) AS unread
       FROM conversations c
       JOIN users u ON u.id = c.user_id
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length}`,
      params
    );
  },

  async unreadForUser(userId) {
    const row = await one(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND m.sender_role = 'admin' AND m.created_at > c.user_read_at`,
      [userId]
    );
    return row?.n ?? 0;
  },

  /** Is any agent currently polling? Drives the customer's online dot. */
  async supportOnline() {
    const row = await one(
      `SELECT COUNT(*) AS n FROM users
       WHERE role = 'admin' AND last_seen_at > $1`,
      [now() - PRESENCE_WINDOW_MS]
    );
    return (row?.n ?? 0) > 0;
  },
};

/* -------------------------------------------------------------- messages -- */

export const messages = {
  async create({ conversationId, senderId, senderRole, body }) {
    const id = randomUUID();
    const ts = now();
    await query(
      `INSERT INTO messages (id, conversation_id, sender_id, sender_role, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, conversationId, senderId, senderRole, body, ts]
    );
    await query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [ts, conversationId]);
    return this.byId(id);
  },

  byId(id) {
    return one(
      `SELECT m.*, u.name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
      [id]
    );
  },

  /** Page backwards through history: pass the oldest message id you hold. */
  async history(conversationId, { before = null, limit = 50 } = {}) {
    const rows = before
      ? await all(
          `SELECT m.*, u.name AS sender_name FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = $1
             AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
           ORDER BY m.created_at DESC LIMIT $3`,
          [conversationId, before, limit]
        )
      : await all(
          `SELECT m.*, u.name AS sender_name FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = $1
           ORDER BY m.created_at DESC LIMIT $2`,
          [conversationId, limit]
        );
    return rows.reverse();
  },

  /** Everything newer than `after` — the heart of the polling loop. */
  since(conversationId, after) {
    return all(
      `SELECT m.*, u.name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 AND m.created_at > $2
       ORDER BY m.created_at ASC LIMIT 200`,
      [conversationId, after]
    );
  },
};

/* ---------------------------------------------------------- serializers -- */

export const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role };

export const publicMessage = (m) =>
  m && {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    senderRole: m.sender_role,
    senderName: m.sender_name,
    body: m.body,
    createdAt: Number(m.created_at),
  };
