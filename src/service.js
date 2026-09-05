import { conversations, messages, publicMessage } from './db.js';

export const MAX_BODY = 4000;
export const ADMIN_ROOM = 'role:admin';
export const convRoom = (id) => `conv:${id}`;

/**
 * Authorization gate for a thread. Customers may only ever touch their own
 * conversation; admins may touch any. Everything that reads or writes a
 * conversation goes through here.
 */
export function authorizeConversation(user, conversationId) {
  const conversation = conversations.byId(conversationId);
  if (!conversation) return { error: 'Conversation not found', status: 404 };
  if (user.role !== 'admin' && conversation.user_id !== user.id) {
    return { error: 'Not your conversation', status: 403 };
  }
  return { conversation };
}

export function validateBody(raw) {
  if (typeof raw !== 'string') return { error: 'Message must be text' };
  const body = raw.trim();
  if (!body) return { error: 'Message is empty' };
  if (body.length > MAX_BODY) return { error: `Message exceeds ${MAX_BODY} characters` };
  return { body };
}

/** Sliding-window rate limit: 20 messages per 10s per sender. */
const buckets = new Map();
export function rateLimit(userId, limit = 20, windowMs = 10_000) {
  const now = Date.now();
  const hits = (buckets.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(userId, hits);
    return false;
  }
  hits.push(now);
  buckets.set(userId, hits);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, hits] of buckets) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length) buckets.set(id, kept);
    else buckets.delete(id);
  }
}, 60_000).unref();

/** Summary row for the admin inbox, matching the shape of conversations.list(). */
export function inboxRow(conversationId) {
  return conversations.list({ limit: 200 }).find((c) => c.id === conversationId) ?? null;
}

export function createService(io) {
  return {
    /** Persists a message and fans it out to the thread and the admin inbox. */
    send({ conversation, sender, body }) {
      const message = messages.create({
        conversationId: conversation.id,
        senderId: sender.id,
        senderRole: sender.role,
        body,
      });

      // The sender has by definition seen their own thread up to this point.
      conversations.markRead(conversation.id, sender.role);

      const payload = publicMessage(message);
      io.to(convRoom(conversation.id)).emit('message:new', payload);
      io.to(ADMIN_ROOM).emit('inbox:update', inboxRow(conversation.id));
      if (sender.role === 'admin') {
        io.to(`user:${conversation.user_id}`).emit('notify', {
          conversationId: conversation.id,
          preview: payload.body.slice(0, 120),
        });
      }
      return payload;
    },

    /** Broadcasts a status/subject change to both sides. */
    announceConversation(conversationId) {
      const conversation = conversations.byId(conversationId);
      if (!conversation) return null;
      const patch = {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        updatedAt: conversation.updated_at,
      };
      io.to(convRoom(conversation.id)).emit('conversation:updated', patch);
      io.to(ADMIN_ROOM).emit('inbox:update', inboxRow(conversation.id));
      return patch;
    },
  };
}
