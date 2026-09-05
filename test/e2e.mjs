/**
 * End-to-end check against a running server.
 *   BASE=http://localhost:3100 ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/e2e.mjs
 * Exercises the guest flow, the agent flow, live delivery both ways, and the
 * privacy boundary between two different visitors.
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3100';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'support@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'supersecret123';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

async function get(path, cookie) {
  return fetch(BASE + path, { headers: cookie ? { cookie } : {} });
}

async function json(path, cookie, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  return { res, body: await res.json().catch(() => ({})) };
}

const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const waitFor = (socket, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

/* ------------------------------------------------------------------ run -- */

console.log(`\nTesting ${BASE}\n`);

// 1. A visitor gets a session just by loading the page — no sign-up.
const visitPage = await get('/');
const guestCookie = cookieOf(visitPage);
check('visitor gets a guest session cookie from GET /', Boolean(guestCookie));

const { body: meBody } = await json('/api/me', guestCookie);
check('guest identity exists', meBody.user?.role === 'user', JSON.stringify(meBody));
check('guest has no email on file', meBody.user?.email == null);

// 2. The guest opens their private thread over the socket and writes in.
const guest = await connect(guestCookie);
const joined = await emit(guest, 'conversation:join', {});
check('guest joins their own conversation', Boolean(joined.conversation?.id), joined.error);
const conversationId = joined.conversation.id;

const sent = await emit(guest, 'message:send', {
  conversationId,
  body: 'My order never arrived.',
});
check('guest can send a message', sent.message?.body === 'My order never arrived.', sent.error);

// 3. The agent signs in and sees the thread in their inbox.
const { res: loginRes, body: loginBody } = await json('/api/auth/agent-login', null, {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminCookie = cookieOf(loginRes);
check('agent signs in', loginBody.user?.role === 'admin', JSON.stringify(loginBody));

const { body: inbox } = await json('/api/admin/conversations', adminCookie);
const row = inbox.conversations?.find((c) => c.id === conversationId);
check('conversation appears in the agent inbox', Boolean(row));
check('inbox shows the unread count', row?.unread === 1, `unread=${row?.unread}`);
check('inbox shows the last message', row?.last_body === 'My order never arrived.');

// 4. The agent replies and the guest receives it live.
const admin = await connect(adminCookie);
const adminJoined = await emit(admin, 'conversation:join', { conversationId });
check('agent opens the thread', adminJoined.messages?.length === 1, adminJoined.error);

const delivered = waitFor(guest, 'message:new');
await emit(admin, 'message:send', { conversationId, body: 'Sorry about that — checking now.' });
const pushed = await delivered;
check('agent reply reaches the guest in real time', pushed.body === 'Sorry about that — checking now.');
check('reply is tagged as coming from support', pushed.senderRole === 'admin');

// 5. Typing indicators travel between the two sides.
const typingSeen = waitFor(admin, 'typing');
guest.emit('typing', { conversationId, isTyping: true });
const typing = await typingSeen;
check('typing indicator reaches the agent', typing.isTyping === true && typing.role === 'user');

// 6. Privacy: a second visitor must not be able to reach the first one's thread.
const otherCookie = cookieOf(await get('/'));
check('second visitor gets a distinct session', otherCookie && otherCookie !== guestCookie);

const other = await connect(otherCookie);
const intrusion = await emit(other, 'conversation:join', { conversationId });
check(
  'other visitor cannot join someone else’s thread',
  intrusion.conversation?.id !== conversationId,
  JSON.stringify(intrusion).slice(0, 90)
);

const writeAttempt = await emit(other, 'message:send', { conversationId, body: 'let me in' });
check('other visitor cannot post into it', Boolean(writeAttempt.error), JSON.stringify(writeAttempt));

const { res: readAttempt } = await json(`/api/conversations/${conversationId}/messages`, otherCookie);
check('REST history is blocked for other visitors', readAttempt.status === 403, `status=${readAttempt.status}`);

const { res: adminGuard } = await json('/api/admin/conversations', guestCookie);
check('guests cannot read the agent inbox', adminGuard.status === 403, `status=${adminGuard.status}`);

// 7. Resolving a conversation closes the composer for the customer.
const { body: patched } = await json(`/api/admin/conversations/${conversationId}`, adminCookie, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'closed' }),
});
check('agent can resolve a conversation', patched.conversation?.status === 'closed');

const blocked = await emit(guest, 'message:send', { conversationId, body: 'still there?' });
check('customer cannot post to a resolved thread', Boolean(blocked.error), JSON.stringify(blocked));

// 8. Renaming a guest updates what the agent sees.
await json('/api/me', guestCookie, { method: 'PATCH', body: JSON.stringify({ name: 'Dana Reyes' }) });
const { body: inbox2 } = await json('/api/admin/conversations', adminCookie);
check(
  'guest rename shows up in the inbox',
  inbox2.conversations?.find((c) => c.id === conversationId)?.user_name === 'Dana Reyes'
);

for (const socket of [guest, admin, other]) socket.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
