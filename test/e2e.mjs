/**
 * End-to-end check against a running server.
 *   BASE=http://localhost:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/e2e.mjs
 * Exercises the guest flow, the agent flow, delivery in both directions via the
 * polling endpoint, and the privacy boundary between two different visitors.
 */
const BASE = process.env.BASE || 'http://localhost:3000';
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

const cookieOf = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
  const set = raw.filter(Boolean).map((c) => c.split(';')[0]);
  return set.find((c) => !c.endsWith('=')) ?? set[0] ?? '';
};

const get = (path, cookie) => fetch(BASE + path, { headers: cookie ? { cookie } : {} });

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

console.log(`\nTesting ${BASE}\n`);

// 1. A visitor gets a session just by loading the page — no sign-up.
const guestCookie = cookieOf(await get('/'));
check('visitor gets a guest session cookie from GET /', Boolean(guestCookie));

const { body: me } = await json('/api/me', guestCookie);
check('guest identity exists', me.user?.role === 'user', JSON.stringify(me));
check('guest has no email on file', me.user?.email == null);

// 2. Their private thread opens with no account.
const { body: opened } = await json('/api/my/conversation', guestCookie);
const conversationId = opened.conversation?.id;
check('guest thread opens', Boolean(conversationId), JSON.stringify(opened).slice(0, 100));
check('new thread starts empty', opened.messages?.length === 0);

const { res: sendRes, body: sent } = await json(
  `/api/conversations/${conversationId}/messages`,
  guestCookie,
  { method: 'POST', body: JSON.stringify({ body: 'My order never arrived.' }) }
);
check('guest can send a message', sendRes.status === 201 && sent.message?.body === 'My order never arrived.');

// 3. The agent signs in and sees the thread in their inbox.
const { res: loginRes, body: login } = await json('/api/auth/agent-login', null, {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminCookie = cookieOf(loginRes);
check('agent signs in', login.user?.role === 'admin', JSON.stringify(login));

const { body: inbox } = await json('/api/admin/conversations', adminCookie);
const row = inbox.conversations?.find((c) => c.id === conversationId);
check('conversation appears in the agent inbox', Boolean(row));
check('inbox shows the unread count', row?.unread === 1, `unread=${row?.unread}`);
check('inbox shows the last message', row?.last_body === 'My order never arrived.');

// 4. The agent opens it and replies; the guest picks it up by polling.
const { body: openedByAgent } = await json(`/api/admin/conversations/${conversationId}`, adminCookie);
check('agent opens the thread', openedByAgent.messages?.length === 1);

await json(`/api/conversations/${conversationId}/messages`, adminCookie, {
  method: 'POST',
  body: JSON.stringify({ body: 'Sorry about that — checking now.' }),
});

const { body: polled } = await json(
  `/api/conversations/${conversationId}/poll?after=${sent.message.createdAt}`,
  guestCookie
);
check('agent reply reaches the guest via poll', polled.messages?.[0]?.body === 'Sorry about that — checking now.');
check('reply is tagged as coming from support', polled.messages?.[0]?.senderRole === 'admin');
check('poll reports the agent as online', polled.peerOnline === true);

// 5. Typing state travels between the two sides.
await json(`/api/conversations/${conversationId}/typing`, guestCookie, {
  method: 'POST',
  body: JSON.stringify({ isTyping: true }),
});
const { body: agentPoll } = await json(
  `/api/conversations/${conversationId}/poll?after=0`,
  adminCookie
);
check('agent sees the customer typing', agentPoll.peerTyping === true);

// 6. Read receipts: the agent's poll marked the thread read, so the guest sees it.
const { body: receipt } = await json(
  `/api/conversations/${conversationId}/poll?after=0`,
  guestCookie
);
check('guest sees the agent has read the thread', receipt.peerReadAt > 0, `peerReadAt=${receipt.peerReadAt}`);

// 7. Privacy: a second visitor must not reach the first one's thread.
const otherCookie = cookieOf(await get('/'));
check('second visitor gets a distinct session', otherCookie && otherCookie !== guestCookie);

const { res: joinAttempt } = await json(`/api/conversations/${conversationId}/poll`, otherCookie);
check('other visitor cannot poll someone else’s thread', joinAttempt.status === 403, `status=${joinAttempt.status}`);

const { res: writeAttempt } = await json(
  `/api/conversations/${conversationId}/messages`,
  otherCookie,
  { method: 'POST', body: JSON.stringify({ body: 'let me in' }) }
);
check('other visitor cannot post into it', writeAttempt.status === 403, `status=${writeAttempt.status}`);

const { res: readAttempt } = await json(`/api/conversations/${conversationId}/messages`, otherCookie);
check('REST history is blocked for other visitors', readAttempt.status === 403, `status=${readAttempt.status}`);

const { res: adminGuard } = await json('/api/admin/conversations', guestCookie);
check('guests cannot read the agent inbox', adminGuard.status === 403, `status=${adminGuard.status}`);

const { res: anonGuard } = await json('/api/admin/conversations', null);
check('signed-out requests cannot read the inbox', anonGuard.status === 401, `status=${anonGuard.status}`);

// 8. Resolving a conversation closes the composer for the customer.
const { body: patched } = await json(`/api/admin/conversations/${conversationId}`, adminCookie, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'closed' }),
});
check('agent can resolve a conversation', patched.conversation?.status === 'closed');

const { res: blocked } = await json(`/api/conversations/${conversationId}/messages`, guestCookie, {
  method: 'POST',
  body: JSON.stringify({ body: 'still there?' }),
});
check('customer cannot post to a resolved thread', blocked.status === 409, `status=${blocked.status}`);

const { body: closedPoll } = await json(
  `/api/conversations/${conversationId}/poll?after=0`,
  guestCookie
);
check('poll reports the closed status to the customer', closedPoll.status === 'closed');

// 9. Renaming a guest updates what the agent sees.
await json('/api/me', guestCookie, { method: 'PATCH', body: JSON.stringify({ name: 'Dana Reyes' }) });
const { body: inbox2 } = await json('/api/admin/conversations', adminCookie);
check(
  'guest rename shows up in the inbox',
  inbox2.conversations?.find((c) => c.id === conversationId)?.user_name === 'Dana Reyes'
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
