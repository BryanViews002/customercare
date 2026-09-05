import { Router } from 'express';
import { users, conversations, messages, publicUser, publicMessage } from './db.js';
import {
  verifyPassword,
  startSession,
  endSession,
  dropSession,
  requireAuth,
  requireAdmin,
} from './auth.js';
import { authorizeConversation, validateBody, rateLimit } from './service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createRouter(service) {
  const router = Router();

  /* ------------------------------------------------ agent sign-in only -- */

  router.post('/auth/agent-login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });

    const user = users.byEmail(email);
    // One response for unknown email, wrong password, and non-agent accounts.
    if (!user || user.role !== 'admin' || !user.password || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    dropSession(req); // retire any guest session this browser was carrying
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    endSession(req, res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({
      user: publicUser(req.user),
      unread:
        req.user.role === 'admin'
          ? conversations.list({ limit: 500 }).reduce((n, c) => n + c.unread, 0)
          : conversations.unreadForUser(req.user.id),
    });
  });

  /** Visitors can put a real name on their thread so agents know who they are. */
  router.patch('/me', requireAuth, (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ error: 'Name is too short' });
    const user = users.rename(req.user.id, name);
    const conversation = conversations.ensureFor(user.id);
    service.announceConversation(conversation.id);
    res.json({ user: publicUser(user) });
  });

  /* ------------------------------------------------------- my thread -- */

  router.get('/my/conversation', requireAuth, (req, res) => {
    if (req.user.role === 'admin') {
      return res.status(400).json({ error: 'Admins use the support inbox' });
    }
    const conversation = conversations.ensureFor(req.user.id);
    conversations.markRead(conversation.id, 'user');
    res.json({
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        updatedAt: conversation.updated_at,
      },
      messages: messages.history(conversation.id, { limit: 50 }).map(publicMessage),
    });
  });

  /* --------------------------------------------------------- history -- */

  router.get('/conversations/:id/messages', requireAuth, (req, res) => {
    const { conversation, error, status } = authorizeConversation(req.user, req.params.id);
    if (error) return res.status(status).json({ error });
    const before = req.query.before ? String(req.query.before) : null;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    res.json({ messages: messages.history(conversation.id, { before, limit }).map(publicMessage) });
  });

  /** REST fallback for sending — the socket path is preferred. */
  router.post('/conversations/:id/messages', requireAuth, (req, res) => {
    const { conversation, error, status } = authorizeConversation(req.user, req.params.id);
    if (error) return res.status(status).json({ error });
    if (conversation.status === 'closed' && req.user.role !== 'admin') {
      return res.status(409).json({ error: 'This conversation is closed' });
    }
    const check = validateBody(req.body?.body);
    if (check.error) return res.status(400).json({ error: check.error });
    if (!rateLimit(req.user.id)) return res.status(429).json({ error: 'Slow down a moment' });

    res.status(201).json({ message: service.send({ conversation, sender: req.user, body: check.body }) });
  });

  /* --------------------------------------------------- admin console -- */

  router.get('/admin/conversations', requireAdmin, (req, res) => {
    res.json({
      conversations: conversations.list({
        status: String(req.query.status ?? 'all'),
        q: String(req.query.q ?? '').trim(),
        limit: Math.min(Number(req.query.limit) || 100, 200),
      }),
    });
  });

  router.get('/admin/conversations/:id', requireAdmin, (req, res) => {
    const conversation = conversations.byId(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    conversations.markRead(conversation.id, 'admin');
    const customer = users.byId(conversation.user_id);
    res.json({
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        updatedAt: conversation.updated_at,
        customer: publicUser(customer),
        customerLastSeen: customer?.last_seen_at ?? null,
      },
      messages: messages.history(conversation.id, { limit: 50 }).map(publicMessage),
    });
  });

  router.patch('/admin/conversations/:id', requireAdmin, (req, res) => {
    const conversation = conversations.byId(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (req.body?.status !== undefined) {
      if (!['open', 'closed'].includes(req.body.status)) {
        return res.status(400).json({ error: 'Status must be open or closed' });
      }
      conversations.setStatus(conversation.id, req.body.status);
    }
    if (req.body?.subject !== undefined) {
      const subject = String(req.body.subject).trim().slice(0, 120);
      if (!subject) return res.status(400).json({ error: 'Subject cannot be empty' });
      conversations.setSubject(conversation.id, subject);
    }
    res.json({ conversation: service.announceConversation(conversation.id) });
  });

  return router;
}
