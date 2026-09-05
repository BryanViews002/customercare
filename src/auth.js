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

export function startSession(res, userId) {
  const { token, expiresAt } = sessions.create(userId);
  res.cookie(COOKIE_NAME, token, cookieOptions(expiresAt - Date.now()));
  return token;
}

export function endSession(req, res) {
  dropSession(req);
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Invalidates the current session without touching the response cookie —
 *  used when a new session is about to overwrite it anyway. */
export function dropSession(req) {
  sessions.destroy(req.cookies?.[COOKIE_NAME]);
}

/** Populates req.user when a valid session cookie is present. Never rejects. */
export function attachUser(req, _res, next) {
  req.user = sessions.userFor(req.cookies?.[COOKIE_NAME]);
  if (req.user) users.touch(req.user.id);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Session required' });
  next();
}

/**
 * Customers never sign in. The first time a visitor arrives we mint a guest
 * user plus a session cookie, which is what keeps their thread private and
 * lets them come back to it later on the same browser.
 */
export function ensureGuest(req, res) {
  if (req.user) return req.user;
  const guest = users.createGuest();
  startSession(res, guest.id);
  req.user = guest;
  return guest;
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

/**
 * Creates the support admin from env on first boot. Credentials are only ever
 * read from the environment so no password is committed to the repo.
 */
export async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    if (users.adminIds().length === 0) {
      console.warn(
        '[auth] No admin exists and ADMIN_EMAIL / ADMIN_PASSWORD are unset. ' +
          'Set them and restart to create the support account.'
      );
    }
    return null;
  }
  const existing = users.byEmail(email);
  if (existing) {
    if (existing.role !== 'admin') console.warn(`[auth] ${email} exists but is not an admin.`);
    return existing;
  }
  const admin = users.create({
    email,
    name: process.env.ADMIN_NAME || 'Support Team',
    password: await hashPassword(password),
    role: 'admin',
  });
  console.log(`[auth] Created admin account ${admin.email}`);
  return admin;
}
