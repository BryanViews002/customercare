import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH || resolve(process.cwd(), 'data', 'chat.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  -- Customers are guests: no email, no password, identified by their session
  -- cookie alone. Only agents have credentials.
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE,
    name         TEXT NOT NULL,
    password     TEXT,
    role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    subject       TEXT NOT NULL DEFAULT 'Support request',
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    user_read_at  INTEGER NOT NULL DEFAULT 0,
    admin_read_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role     TEXT NOT NULL CHECK (sender_role IN ('user','admin','system')),
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
`);

const now = () => Date.now();

/* ---------------------------------------------------------------- users -- */

export const users = {
  create({ email = null, name, password = null, role = 'user' }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, name, password, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, email ? String(email).toLowerCase() : null, name, password, role, now());
    return this.byId(id);
  },

  /** A visitor with no account: named for the agent's benefit, nothing more. */
  createGuest() {
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    return this.create({ name: `Guest ${tag}` });
  },

  rename(id, name) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    return this.byId(id);
  },

  byId(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  },

  byEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()) ?? null;
  },

  touch(id) {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), id);
  },

  adminIds() {
    return db.prepare("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);
  },
};

/* ------------------------------------------------------------- sessions -- */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const sessions = {
  create(userId) {
    const token = randomUUID() + randomUUID().replaceAll('-', '');
    const ts = now();
    db.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(token, userId, ts, ts + SESSION_TTL_MS);
    return { token, expiresAt: ts + SESSION_TTL_MS };
  },

  userFor(token) {
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, now());
    return row ?? null;
  },

  destroy(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },

  purgeExpired() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  },
};

/* -------------------------------------------------------- conversations -- */

export const conversations = {
  /** Every customer gets exactly one private thread, created on demand. */
  ensureFor(userId) {
    const existing = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(userId);
    if (existing) return existing;
    const id = randomUUID();
    const ts = now();
    db.prepare(
      'INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(id, userId, ts, ts);
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  },

  byId(id) {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) ?? null;
  },

  setStatus(id, status) {
    db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.byId(id);
  },

  setSubject(id, subject) {
    db.prepare('UPDATE conversations SET subject = ?, updated_at = ? WHERE id = ?').run(subject, now(), id);
    return this.byId(id);
  },

  markRead(id, role) {
    const column = role === 'admin' ? 'admin_read_at' : 'user_read_at';
    db.prepare(`UPDATE conversations SET ${column} = ? WHERE id = ?`).run(now(), id);
  },

  /** Inbox rows for the admin console, newest activity first. */
  list({ status = 'all', q = '', limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (status === 'open' || status === 'closed') {
      clauses.push('c.status = ?');
      params.push(status);
    }
    if (q) {
      clauses.push('(u.name LIKE ? OR u.email LIKE ? OR c.subject LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);

    return db
      .prepare(
        `SELECT c.id, c.subject, c.status, c.updated_at, c.admin_read_at,
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
         LIMIT ?`
      )
      .all(...params);
  },

  unreadForUser(userId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ? AND m.sender_role = 'admin' AND m.created_at > c.user_read_at`
      )
      .get(userId);
    return row?.n ?? 0;
  },
};

/* ------------------------------------------------------------- messages -- */

export const messages = {
  create({ conversationId, senderId, senderRole, body }) {
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, sender_role, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, conversationId, senderId, senderRole, body, ts);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
    return this.byId(id);
  },

  byId(id) {
    return (
      db
        .prepare(
          `SELECT m.*, u.name AS sender_name FROM messages m
           JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
        )
        .get(id) ?? null
    );
  },

  /** Page backwards through history: pass the oldest message id you hold. */
  history(conversationId, { before = null, limit = 50 } = {}) {
    const rows = before
      ? db
          .prepare(
            `SELECT m.*, u.name AS sender_name FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.conversation_id = ?
               AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
             ORDER BY m.created_at DESC LIMIT ?`
          )
          .all(conversationId, before, limit)
      : db
          .prepare(
            `SELECT m.*, u.name AS sender_name FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.conversation_id = ?
             ORDER BY m.created_at DESC LIMIT ?`
          )
          .all(conversationId, limit);
    return rows.reverse();
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
    createdAt: m.created_at,
  };
