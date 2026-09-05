import { conversations, messages, publicMessage } from './db.js';

export const MAX_BODY = 4000;

/**
 * Authorization gate for a thread. Customers may only ever touch their own
 * conversation; admins may touch any. Everything that reads or writes a
 * conversation goes through here.
 */
export async function authorizeConversation(user, conversationId) {
  const conversation = await conversations.byId(conversationId);
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

/**
 * Sliding-window rate limit: 20 messages per 10s per sender.
 *
 * This is per warm instance, so on serverless it is a speed bump rather than a
 * hard guarantee — a burst spread across cold starts can exceed it. Move it to
 * the database or Redis if you need a real ceiling.
 */
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
  if (buckets.size > 5000) buckets.clear(); // bound memory on a long-lived instance
  return true;
}

/** Persists a message and marks the sender's own side as caught up. */
export async function sendMessage({ conversation, sender, body }) {
  const message = await messages.create({
    conversationId: conversation.id,
    senderId: sender.id,
    senderRole: sender.role,
    body,
  });
  await conversations.markRead(conversation.id, sender.role);
  await conversations.markTyping(conversation.id, sender.role, false);
  return publicMessage(message);
}
