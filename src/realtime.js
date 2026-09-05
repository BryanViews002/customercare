import cookie from 'cookie';
import { users, sessions, conversations, messages, publicMessage } from './db.js';
import { COOKIE_NAME } from './auth.js';
import { authorizeConversation, validateBody, rateLimit, ADMIN_ROOM, convRoom } from './service.js';

/** userId -> Set of socket ids, so presence survives multiple tabs. */
const online = new Map();

const isOnline = (userId) => (online.get(userId)?.size ?? 0) > 0;

export function attachRealtime(io, service) {
  // Authenticate every socket from the same session cookie the pages use.
  io.use((socket, next) => {
    const raw = socket.handshake.headers.cookie ?? '';
    const token = cookie.parse(raw)[COOKIE_NAME];
    const user = sessions.userFor(token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    socket.join(`user:${user.id}`);
    if (user.role === 'admin') socket.join(ADMIN_ROOM);

    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    users.touch(user.id);
    broadcastPresence(io, user, true);

    socket.emit('ready', {
      user: { id: user.id, name: user.name, role: user.role },
      onlineAdmins: users.adminIds().some(isOnline),
    });

    /* --------------------------------------------------------- joining -- */

    socket.on('conversation:join', (payload, ack) => {
      const conversationId =
        user.role === 'admin' ? payload?.conversationId : conversations.ensureFor(user.id).id;
      const { conversation, error } = authorizeConversation(user, conversationId ?? '');
      if (error) return ack?.({ error });

      // A socket follows one thread at a time; drop any previous room.
      for (const room of socket.rooms) {
        if (room.startsWith('conv:')) socket.leave(room);
      }
      socket.join(convRoom(conversation.id));
      conversations.markRead(conversation.id, user.role);

      const customer = users.byId(conversation.user_id);
      ack?.({
        conversation: {
          id: conversation.id,
          subject: conversation.subject,
          status: conversation.status,
          customer: { id: customer.id, name: customer.name, email: customer.email },
          customerOnline: isOnline(customer.id),
          adminOnline: users.adminIds().some(isOnline),
        },
        messages: messages.history(conversation.id, { limit: 50 }).map(publicMessage),
      });
    });

    /* --------------------------------------------------------- sending -- */

    socket.on('message:send', (payload, ack) => {
      const { conversation, error } = authorizeConversation(user, payload?.conversationId ?? '');
      if (error) return ack?.({ error });
      if (conversation.status === 'closed' && user.role !== 'admin') {
        return ack?.({ error: 'This conversation has been closed. Reopen it from support.' });
      }
      const check = validateBody(payload?.body);
      if (check.error) return ack?.({ error: check.error });
      if (!rateLimit(user.id)) return ack?.({ error: 'You are sending messages too quickly' });

      const message = service.send({ conversation, sender: user, body: check.body });
      ack?.({ message, tempId: payload?.tempId ?? null });
    });

    /* ------------------------------------------------- typing and read -- */

    socket.on('typing', (payload) => {
      const { conversation, error } = authorizeConversation(user, payload?.conversationId ?? '');
      if (error) return;
      socket.to(convRoom(conversation.id)).emit('typing', {
        conversationId: conversation.id,
        role: user.role,
        name: user.name,
        isTyping: Boolean(payload?.isTyping),
      });
    });

    socket.on('conversation:read', (payload) => {
      const { conversation, error } = authorizeConversation(user, payload?.conversationId ?? '');
      if (error) return;
      conversations.markRead(conversation.id, user.role);
      socket.to(convRoom(conversation.id)).emit('conversation:read', {
        conversationId: conversation.id,
        role: user.role,
        at: Date.now(),
      });
      if (user.role === 'admin') io.to(ADMIN_ROOM).emit('inbox:update', inbox(conversation.id));
    });

    /* ------------------------------------------------------ history page -- */

    socket.on('messages:history', (payload, ack) => {
      const { conversation, error } = authorizeConversation(user, payload?.conversationId ?? '');
      if (error) return ack?.({ error });
      ack?.({
        messages: messages
          .history(conversation.id, { before: payload?.before ?? null, limit: 50 })
          .map(publicMessage),
      });
    });

    /* ----------------------------------------------------- disconnecting -- */

    socket.on('disconnect', () => {
      const set = online.get(user.id);
      set?.delete(socket.id);
      if (set && set.size === 0) {
        online.delete(user.id);
        users.touch(user.id);
        broadcastPresence(io, user, false);
      }
    });
  });
}

function inbox(conversationId) {
  return conversations.list({ limit: 200 }).find((c) => c.id === conversationId) ?? null;
}

function broadcastPresence(io, user, isUp) {
  if (user.role === 'admin') {
    // Customers only need to know whether *any* agent is available.
    io.emit('presence:support', { online: users.adminIds().some(isOnline) });
  } else {
    io.to(ADMIN_ROOM).emit('presence:user', { userId: user.id, online: isUp });
    const conversation = conversations.ensureFor(user.id);
    io.to(convRoom(conversation.id)).emit('presence:user', { userId: user.id, online: isUp });
  }
}
