import { Router } from 'express';
import {
  users,
  conversations,
  messages,
  publicUser,
  publicMessage,
  TYPING_WINDOW_MS,
  PRESENCE_WINDOW_MS,
} from './db.js';
import {
  verifyPassword,
  startSession,
  endSession,
  dropSession,
  requireAuth,
  requireAdmin,
} from './auth.js';
import { authorizeConversation, validateBody, rateLimit, sendMessage } from './service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Wraps an async handler and answers the request itself on failure.
 *
 * Delegating to Express's error middleware proved unreliable inside Vercel's
 * function runtime — a rejection there took down the whole invocation with an
 * opaque FUNCTION_INVOCATION_FAILED instead of producing a response. Replying
 * from inside the handler keeps every failure legible.
 */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`[api] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    if (err?.code === 'CONFIG') return res.status(503).json({ error: err.message });
    res.status(500).json({ error: 'Something went wrong' });
  });

export function createRouter() {
  const router = Router();

  /**
   * Diagnostics that never throw: says whether the function booted, what
   * database it thinks it has, and why a connection failed if it did.
   */
  router.get('/health', async (_req, res) => {
    const report = {
      ok: true,
      runtime: process.version,
      onVercel: Boolean(process.env.VERCEL),
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      hasPostgresUrl: Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL),
      hasAdminEnv: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
    };
    try {
      const { db } = await import('./db.js');
      const client = await db();
      const result = await client.query('SELECT COUNT(*) AS n FROM conversations');
      report.database = 'connected';
      report.conversations = Number(result.rows[0].n);
    } catch (err) {
      report.ok = false;
      report.database = 'unavailable';
      report.error = String(err?.message ?? err).slice(0, 300);
      report.errorCode = err?.code ?? null;
    }
    res.status(report.ok ? 200 : 503).json(report);
  });

  /* ------------------------------------------------ agent sign-in only -- */

  router.post(
    '/auth/agent-login',
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

      const user = await users.byEmail(email);
      // One response for unknown email, wrong password, and non-agent accounts.
      if (
        !user ||
        user.role !== 'admin' ||
        !user.password ||
        !(await verifyPassword(password, user.password))
      ) {
        return res.status(401).json({ error: 'Incorrect email or password' });
      }
      await dropSession(req); // retire any guest session this browser was carrying
      await startSession(res, user.id);
      res.json({ user: publicUser(user) });
    })
  );

  router.post(
    '/auth/logout',
    wrap(async (req, res) => {
      await endSession(req, res);
      res.json({ ok: true });
    })
  );

  router.get(
    '/me',
    wrap(async (req, res) => {
      if (!req.user) return res.json({ user: null });
      res.json({ user: publicUser(req.user) });
    })
  );

  /** Visitors can put a real name on their thread so agents know who they are. */
  router.patch(
    '/me',
    requireAuth,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim().slice(0, 60);
      if (name.length < 2) return res.status(400).json({ error: 'Name is too short' });
      res.json({ user: publicUser(await users.rename(req.user.id, name)) });
    })
  );

  /* --------------------------------------------------- customer thread -- */

  router.get(
    '/my/conversation',
    requireAuth,
    wrap(async (req, res) => {
      if (req.user.role === 'admin') {
        return res.status(400).json({ error: 'Agents use the support inbox' });
      }
      const conversation = await conversations.ensureFor(req.user.id);
      await conversations.markRead(conversation.id, 'user');
      res.json({
        conversation: {
          id: conversation.id,
          subject: conversation.subject,
          status: conversation.status,
          customer: publicUser(req.user),
        },
        messages: (await messages.history(conversation.id, { limit: 50 })).map(publicMessage),
        supportOnline: await conversations.supportOnline(),
      });
    })
  );

  /* ------------------------------------------------------------ polling -- */

  /**
   * The whole realtime layer, in one request. The client calls this every few
   * seconds with the timestamp of the newest message it holds and gets back
   * anything newer plus the peer's typing/read state.
   */
  router.get(
    '/conversations/:id/poll',
    requireAuth,
    wrap(async (req, res) => {
      const { conversation, error, status } = await authorizeConversation(req.user, req.params.id);
      if (error) return res.status(status).json({ error });

      const after = Number(req.query.after) || 0;
      const fresh = (await messages.since(conversation.id, after)).map(publicMessage);

      // Seeing the thread counts as reading it.
      if (fresh.some((m) => m.senderId !== req.user.id)) {
        await conversations.markRead(conversation.id, req.user.role);
      }

      const peerIsAdmin = req.user.role !== 'admin';
      const typingAt = peerIsAdmin ? conversation.admin_typing_at : conversation.user_typing_at;
      const peerReadAt = peerIsAdmin ? conversation.admin_read_at : conversation.user_read_at;
      const customer = await users.byId(conversation.user_id);

      res.json({
        messages: fresh,
        status: conversation.status,
        peerTyping: Date.now() - Number(typingAt) < TYPING_WINDOW_MS,
        peerReadAt: Number(peerReadAt),
        peerOnline: peerIsAdmin
          ? await conversations.supportOnline()
          : Date.now() - Number(customer?.last_seen_at ?? 0) < PRESENCE_WINDOW_MS,
      });
    })
  );

  router.post(
    '/conversations/:id/typing',
    requireAuth,
    wrap(async (req, res) => {
      const { conversation, error, status } = await authorizeConversation(req.user, req.params.id);
      if (error) return res.status(status).json({ error });
      await conversations.markTyping(conversation.id, req.user.role, Boolean(req.body?.isTyping));
      res.json({ ok: true });
    })
  );

  /* ---------------------------------------------------- history + send -- */

  router.get(
    '/conversations/:id/messages',
    requireAuth,
    wrap(async (req, res) => {
      const { conversation, error, status } = await authorizeConversation(req.user, req.params.id);
      if (error) return res.status(status).json({ error });
      const before = req.query.before ? String(req.query.before) : null;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      res.json({
        messages: (await messages.history(conversation.id, { before, limit })).map(publicMessage),
      });
    })
  );

  router.post(
    '/conversations/:id/messages',
    requireAuth,
    wrap(async (req, res) => {
      const { conversation, error, status } = await authorizeConversation(req.user, req.params.id);
      if (error) return res.status(status).json({ error });
      if (conversation.status === 'closed' && req.user.role !== 'admin') {
        return res.status(409).json({ error: 'This conversation is closed' });
      }
      const check = validateBody(req.body?.body);
      if (check.error) return res.status(400).json({ error: check.error });
      if (!rateLimit(req.user.id)) return res.status(429).json({ error: 'Slow down a moment' });

      res.status(201).json({
        message: await sendMessage({ conversation, sender: req.user, body: check.body }),
      });
    })
  );

  /* --------------------------------------------------- agent console -- */

  router.get(
    '/admin/conversations',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({
        conversations: await conversations.list({
          status: String(req.query.status ?? 'all'),
          q: String(req.query.q ?? '').trim(),
          limit: Math.min(Number(req.query.limit) || 100, 200),
        }),
        presenceWindowMs: PRESENCE_WINDOW_MS,
        now: Date.now(),
      });
    })
  );

  router.get(
    '/admin/conversations/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const conversation = await conversations.byId(req.params.id);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      await conversations.markRead(conversation.id, 'admin');
      const customer = await users.byId(conversation.user_id);
      res.json({
        conversation: {
          id: conversation.id,
          subject: conversation.subject,
          status: conversation.status,
          customer: publicUser(customer),
          customerOnline: Date.now() - Number(customer?.last_seen_at ?? 0) < PRESENCE_WINDOW_MS,
        },
        messages: (await messages.history(conversation.id, { limit: 50 })).map(publicMessage),
      });
    })
  );

  router.patch(
    '/admin/conversations/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const conversation = await conversations.byId(req.params.id);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

      let updated = conversation;
      if (req.body?.status !== undefined) {
        if (!['open', 'closed'].includes(req.body.status)) {
          return res.status(400).json({ error: 'Status must be open or closed' });
        }
        updated = await conversations.setStatus(conversation.id, req.body.status);
      }
      if (req.body?.subject !== undefined) {
        const subject = String(req.body.subject).trim().slice(0, 120);
        if (!subject) return res.status(400).json({ error: 'Subject cannot be empty' });
        updated = await conversations.setSubject(conversation.id, subject);
      }
      res.json({
        conversation: { id: updated.id, subject: updated.subject, status: updated.status },
      });
    })
  );

  return router;
}
