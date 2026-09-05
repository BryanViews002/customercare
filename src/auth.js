import bcrypt from 'bcryptjs';
import { users, sessions } from './db.js';

export const COOKIE_NAME = 'ccc_sid';
const ROUNDS = 10;

const cookieOptions = (maxAgeMs) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: maxAgeMs,
  path: '/',
});

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export async function startSession(res, userId) {
  const { token, expiresAt } = await sessions.create(userId);
  res.cookie(COOKIE_NAME, token, cookieOptions(expiresAt - Date.now()));
  return token;
}

export async function endSession(req, res) {
  await dropSession(req);
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Invalidates the current session without touching the response cookie —
 *  used when a new session is about to overwrite it anyway. */
export function dropSession(req) {
  return sessions.destroy(req.cookies?.[COOKIE_NAME]);
}

/**
 * Populates req.user when a valid session cookie is present. Never rejects.
 * Also refreshes last_seen_at, which is what presence is derived from now that
 * there are no sockets to count.
 */
export async function attachUser(req, _res, next) {
  try {
    req.user = await sessions.userFor(req.cookies?.[COOKIE_NAME]);
    if (req.user) await users.touch(req.user.id);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Session required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Session required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

/**
 * Customers never sign in. The first time a visitor arrives we mint a guest
 * user plus a session cookie, which is what keeps their thread private and
 * lets them come back to it later on the same browser.
 */
export async function ensureGuest(req, res) {
  if (req.user) return req.user;
  const guest = await users.createGuest();
  await startSession(res, guest.id);
  req.user = guest;
  return guest;
}
